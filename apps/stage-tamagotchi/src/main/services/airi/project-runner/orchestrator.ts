import type { Project, ProjectAgentSettings, WorkItem, WorkItemRunLifecycleStatus, WorkItemRunRecord } from '@proj-airi/stage-projects'

import type { AgentChatMessage, AgentRuntimeFetch } from './agent-runtime'
import type { ProjectRunnerContextPack, ProjectRunnerContextSource } from './context-pack'
import type { ProjectSubtaskProgress, ReviewerAgentResult, WorkerAgentResult } from './review-loop'

import { errorMessageFrom } from '@moeru/std'
import { isPathAllowed } from '@proj-airi/stage-projects'

import { callAgentText } from './agent-runtime'
import { buildProjectRunnerContextPack, formatProjectRunnerContextPack } from './context-pack'
import { buildProjectReviewerEvidencePack, formatProjectReviewerEvidencePack } from './evidence'
import { classifyProjectRunnerFailure } from './failure'
import {
  buildAgentRunWorktreeBranchName,
  buildAgentRunWorktreePath,
  commitAgentChangedFiles,
  createAgentWorktree,
  getAgentDiffSummary,
  getGitChangedFiles,
  integrateAgentBranchIntoProject,
  removeAgentWorktree,
  revertAgentChangedFiles,
} from './git'
import { compactAgentMessages } from './message-compaction'
import { runProjectReviewLoop } from './review-loop'
import { normalizeSuggestedTestCommands, runProjectTestCommand } from './tests'
import {
  applyStructuredProjectPatch,
  findProjectFiles,
  indexProjectSymbols,
  listProjectDirectory,
  readProjectFile,
  replaceInProjectFile,
  runProjectShellCommand,
  searchProjectFiles,
  writeProjectFile,
} from './tools'

type WorkerAction
  = | { action: 'list', path?: string }
    | { action: 'read', path: string }
    | { action: 'search', query: string, path?: string, regex?: boolean }
    | { action: 'find', query: string, path?: string }
    | { action: 'index', path?: string }
    | { action: 'replace', path: string, search: string, replace: string, replaceAll?: boolean }
    | { action: 'patch', files: StructuredPatchFileInput[] }
    | { action: 'write', path: string, content: string }
    | { action: 'shell', command: string }
    | { action: 'status' }
    | { action: 'diff' }
    | { action: 'test', commands?: string[] }
    | { action: 'explore', objective: string }
    | { action: 'subtask', evidence?: string, status: ProjectSubtaskProgress['status'], title: string }
    | { action: 'blocked', comment: string, failureKind?: WorkerAgentResult['failureKind'], questions?: string[], subtaskProgress?: ProjectSubtaskProgress[] }
    | { action: 'final', acceptanceEvidence: AcceptanceCriterionEvidence[], comment: string, subtaskProgress?: ProjectSubtaskProgress[] }

type ReviewerAction
  = | { action: 'list', path?: string }
    | { action: 'read', path: string }
    | { action: 'search', query: string, path?: string, regex?: boolean }
    | { action: 'find', query: string, path?: string }
    | { action: 'index', path?: string }
    | { action: 'status' }
    | { action: 'diff' }
    | { action: 'test', commands?: string[] }
    | { action: 'final', decision: ReviewerDecision }

type ReviewerFindingSeverity = 'blocker' | 'major' | 'minor' | 'nit'

interface StructuredPatchEditInput {
  search: string
  replace: string
  replaceAll?: boolean
}

interface StructuredPatchFileInput {
  path: string
  edits: StructuredPatchEditInput[]
}

interface AcceptanceCriterionEvidence {
  criterion: string
  evidence: string
  status: 'missing' | 'not_applicable' | 'satisfied'
}

interface ReviewerFinding {
  severity: ReviewerFindingSeverity
  file?: string
  line?: number
  message: string
  requiredChange?: string
}

interface ReviewerDecision {
  passed: boolean
  comment: string
  findings: ReviewerFinding[]
  requiredChanges: string[]
  suggestedTests: string[]
  acceptanceEvidence: AcceptanceCriterionEvidence[]
  confidence?: number
  failureKind?: ReviewerAgentResult['failureKind']
}

interface ProjectManagerBrief {
  summary: string
  likelyFiles: string[]
  implementationPlan: string[]
  subtasks: string[]
  riskNotes: string[]
  reviewFocus: string[]
  suggestedTests: string[]
  openQuestions: string[]
}

interface ProjectRunnerStore {
  addComment: (payload: { actorType: 'worker' | 'reviewer' | 'system', content: string, kind: 'worker' | 'review' | 'status' | 'diff' | 'test' | 'commit', workItemId: string }) => unknown
  getSnapshot?: () => ProjectRunnerContextSource
  updateWorkItem: (payload: { id: string, patch: { status: WorkItem['status'] } }) => WorkItem
  upsertRunRecord: (run: WorkItemRunRecord) => WorkItemRunRecord
}

/**
 * Finds the first balanced JSON object substring, ignoring braces inside string literals.
 *
 * Before:
 * - "Here is the action:\n```json\n{\"action\":\"final\"}\n```\nLet me know."
 *
 * After:
 * - "{\"action\":\"final\"}"
 */
function findBalancedJsonObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0)
    return undefined

  let depth = 0
  let inString = false
  let escaped = false
  // Scan from the first brace, tracking string context so braces inside string values are ignored.
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped)
        escaped = false
      else if (char === '\\')
        escaped = true
      else if (char === '"')
        inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      depth += 1
    }
    else if (char === '}') {
      depth -= 1
      if (depth === 0)
        return text.slice(start, i + 1)
    }
  }
  return undefined
}

/**
 * Extracts a JSON object from a model response, tolerating code fences and surrounding prose.
 *
 * Before:
 * - "```json\n{\"action\":\"final\",\"comment\":\"done\"}\n```"
 * - "Sure, here is my action: {\"action\":\"read\",\"path\":\"a.ts\"} — let me know."
 *
 * After:
 * - `{ action: "final", comment: "done" }`
 */
export function parseAgentJsonObject(text: string): Record<string, unknown> {
  const source = findBalancedJsonObject(text)
  if (source === undefined)
    throw new Error('Agent response must contain a JSON object.')

  const parsed = JSON.parse(source) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Agent response must be a JSON object.')
  return parsed as Record<string, unknown>
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`Agent JSON field "${field}" must be a non-empty string.`)
  return value
}

function asStringValue(value: unknown, field: string): string {
  if (typeof value !== 'string')
    throw new Error(`Agent JSON field "${field}" must be a string.`)
  return value
}

function asObjectArray(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value))
    throw new Error(`Agent JSON field "${field}" must be an array.`)
  return value.filter(isRecord)
}

function parseAcceptanceEvidence(value: unknown): AcceptanceCriterionEvidence[] {
  if (!Array.isArray(value))
    return []

  return value
    .filter(isRecord)
    .map((item): AcceptanceCriterionEvidence | undefined => {
      const criterion = asOptionalString(item.criterion)
      const evidence = asOptionalString(item.evidence)
      const status = item.status === 'satisfied' || item.status === 'not_applicable' || item.status === 'missing'
        ? item.status
        : undefined
      if (!criterion || !status)
        return undefined

      return {
        criterion,
        evidence: evidence ?? '',
        status,
      }
    })
    .filter((item): item is AcceptanceCriterionEvidence => !!item)
}

function parseSubtaskStatus(value: unknown): ProjectSubtaskProgress['status'] {
  return value === 'todo' || value === 'in_progress' || value === 'done' || value === 'blocked'
    ? value
    : 'in_progress'
}

function parseSubtaskProgress(value: unknown): ProjectSubtaskProgress[] {
  if (!Array.isArray(value))
    return []

  return value
    .filter(isRecord)
    .map((item): ProjectSubtaskProgress | undefined => {
      const title = asOptionalString(item.title)
      if (!title)
        return undefined

      return {
        title,
        status: parseSubtaskStatus(item.status),
        evidence: asOptionalString(item.evidence),
      }
    })
    .filter((item): item is ProjectSubtaskProgress => !!item)
}

function parseFailureKind(value: unknown): WorkerAgentResult['failureKind'] {
  return value === 'agent_error'
    || value === 'forbidden_path'
    || value === 'integration_failed'
    || value === 'missing_acceptance_evidence'
    || value === 'no_changes'
    || value === 'review_rejected'
    || value === 'validation_failed'
    || value === 'worker_blocked'
    ? value
    : undefined
}

function parseStructuredPatchFiles(value: unknown): StructuredPatchFileInput[] {
  return asObjectArray(value, 'files')
    .map((file): StructuredPatchFileInput => ({
      path: asString(file.path, 'path'),
      edits: asObjectArray(file.edits, 'edits').map(edit => ({
        search: asString(edit.search, 'search'),
        replace: asStringValue(edit.replace, 'replace'),
        replaceAll: edit.replaceAll === true,
      })),
    }))
    .filter(file => file.edits.length > 0)
}

function parseWorkerAction(text: string): WorkerAction {
  const parsed = parseAgentJsonObject(text)
  const action = asString(parsed.action, 'action')
  switch (action) {
    case 'list':
      return { action, path: typeof parsed.path === 'string' ? parsed.path : undefined }
    case 'read':
      return { action, path: asString(parsed.path, 'path') }
    case 'search':
      return {
        action,
        query: asString(parsed.query, 'query'),
        path: typeof parsed.path === 'string' ? parsed.path : undefined,
        regex: parsed.regex === true,
      }
    case 'find':
      return {
        action,
        query: asString(parsed.query, 'query'),
        path: typeof parsed.path === 'string' ? parsed.path : undefined,
      }
    case 'index':
      return { action, path: typeof parsed.path === 'string' ? parsed.path : undefined }
    case 'replace':
      return {
        action,
        path: asString(parsed.path, 'path'),
        search: asString(parsed.search, 'search'),
        replace: asStringValue(parsed.replace, 'replace'),
        replaceAll: parsed.replaceAll === true,
      }
    case 'patch':
      return {
        action,
        files: parseStructuredPatchFiles(parsed.files),
      }
    case 'write':
      return {
        action,
        path: asString(parsed.path, 'path'),
        content: asStringValue(parsed.content, 'content'),
      }
    case 'shell':
      return { action, command: asString(parsed.command, 'command') }
    case 'status':
      return { action }
    case 'diff':
      return { action }
    case 'test':
      return {
        action,
        commands: asStringArray(parsed.commands),
      }
    case 'explore':
      return { action, objective: asString(parsed.objective, 'objective') }
    case 'subtask':
      return {
        action,
        title: asString(parsed.title, 'title'),
        status: parseSubtaskStatus(parsed.status),
        evidence: asOptionalString(parsed.evidence),
      }
    case 'blocked':
      return {
        action,
        comment: asString(parsed.comment, 'comment'),
        failureKind: parseFailureKind(parsed.failureKind),
        questions: asStringArray(parsed.questions),
        subtaskProgress: parseSubtaskProgress(parsed.subtaskProgress),
      }
    case 'final':
      return {
        action,
        acceptanceEvidence: parseAcceptanceEvidence(parsed.acceptanceEvidence),
        comment: asString(parsed.comment, 'comment'),
        subtaskProgress: parseSubtaskProgress(parsed.subtaskProgress),
      }
    default:
      throw new Error(`Unsupported worker action: ${action}`)
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseReviewerSeverity(value: unknown): ReviewerFindingSeverity {
  return value === 'blocker' || value === 'major' || value === 'minor' || value === 'nit'
    ? value
    : 'major'
}

function parseReviewerFindings(value: unknown): ReviewerFinding[] {
  if (!Array.isArray(value))
    return []

  return value
    .filter(isRecord)
    .map((finding): ReviewerFinding | undefined => {
      const message = asOptionalString(finding.message)
      if (!message)
        return undefined

      const line = typeof finding.line === 'number' && Number.isFinite(finding.line)
        ? Math.max(1, Math.floor(finding.line))
        : undefined
      return {
        severity: parseReviewerSeverity(finding.severity),
        file: asOptionalString(finding.file),
        line,
        message,
        requiredChange: asOptionalString(finding.requiredChange),
      }
    })
    .filter((finding): finding is ReviewerFinding => !!finding)
}

function parseReviewerDecisionObject(parsed: Record<string, unknown>): ReviewerDecision {
  if (typeof parsed.passed !== 'boolean')
    throw new Error('Reviewer JSON field "passed" must be a boolean.')

  const confidence = typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
    ? Math.min(1, Math.max(0, parsed.confidence))
    : undefined
  return {
    passed: parsed.passed,
    comment: asString(parsed.comment, 'comment'),
    findings: parseReviewerFindings(parsed.findings),
    requiredChanges: asStringArray(parsed.requiredChanges),
    suggestedTests: asStringArray(parsed.suggestedTests),
    acceptanceEvidence: parseAcceptanceEvidence(parsed.acceptanceEvidence),
    confidence,
    failureKind: parseFailureKind(parsed.failureKind),
  }
}

function parseReviewerAction(text: string): ReviewerAction {
  const parsed = parseAgentJsonObject(text)
  if (typeof parsed.passed === 'boolean') {
    return {
      action: 'final',
      decision: parseReviewerDecisionObject(parsed),
    }
  }

  const action = asString(parsed.action, 'action')
  switch (action) {
    case 'list':
      return { action, path: typeof parsed.path === 'string' ? parsed.path : undefined }
    case 'read':
      return { action, path: asString(parsed.path, 'path') }
    case 'search':
      return {
        action,
        query: asString(parsed.query, 'query'),
        path: typeof parsed.path === 'string' ? parsed.path : undefined,
        regex: parsed.regex === true,
      }
    case 'find':
      return {
        action,
        query: asString(parsed.query, 'query'),
        path: typeof parsed.path === 'string' ? parsed.path : undefined,
      }
    case 'index':
      return { action, path: typeof parsed.path === 'string' ? parsed.path : undefined }
    case 'status':
      return { action }
    case 'diff':
      return { action }
    case 'test':
      return {
        action,
        commands: asStringArray(parsed.commands),
      }
    case 'final':
      return {
        action,
        decision: parseReviewerDecisionObject(isRecord(parsed.decision) ? parsed.decision : parsed),
      }
    default:
      throw new Error(`Unsupported reviewer action: ${action}`)
  }
}

/**
 * Normalizes optional model JSON list fields.
 *
 * Before:
 * - `[" Read file ", "", 42]`
 *
 * After:
 * - `["Read file"]`
 */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value))
    return []

  return value
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean)
}

function parseProjectManagerBrief(text: string): ProjectManagerBrief {
  const parsed = parseAgentJsonObject(text)
  return {
    summary: asString(parsed.summary, 'summary'),
    likelyFiles: asStringArray(parsed.likelyFiles),
    implementationPlan: asStringArray(parsed.implementationPlan),
    subtasks: asStringArray(parsed.subtasks),
    riskNotes: asStringArray(parsed.riskNotes),
    reviewFocus: asStringArray(parsed.reviewFocus),
    suggestedTests: asStringArray(parsed.suggestedTests),
    openQuestions: asStringArray(parsed.openQuestions),
  }
}

function truncateToolResult(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text.length <= 12000)
    return text
  return `${text.slice(0, 12000)}\n[truncated ${text.length - 12000} chars]`
}

function formatBriefList(title: string, items: string[]): string {
  if (items.length === 0)
    return ''

  return `${title}:\n${items.map(item => `- ${item}`).join('\n')}`
}

function formatProjectManagerBrief(brief: ProjectManagerBrief): string {
  return [
    `Summary: ${brief.summary}`,
    formatBriefList('Likely files', brief.likelyFiles),
    formatBriefList('Implementation plan', brief.implementationPlan),
    formatBriefList('Subtasks', brief.subtasks),
    formatBriefList('Risk notes', brief.riskNotes),
    formatBriefList('Review focus', brief.reviewFocus),
    formatBriefList('Suggested tests', brief.suggestedTests),
    formatBriefList('Open questions', brief.openQuestions),
  ].filter(Boolean).join('\n\n')
}

/**
 * Normalizes verifier commands from settings.
 *
 * Before:
 * - undefined
 *
 * After:
 * - []
 */
function normalizeVerifierCommands(settings: ProjectAgentSettings): string[] {
  const commands = (settings as Partial<ProjectAgentSettings>).verifierCommands
  return Array.isArray(commands) ? commands : []
}

function buildRunVerificationCommands(params: {
  managerBrief?: ProjectManagerBrief
  settings: ProjectAgentSettings
}): string[] {
  return normalizeSuggestedTestCommands([
    ...normalizeVerifierCommands(params.settings),
    ...(params.managerBrief?.suggestedTests ?? []),
  ])
}

function formatAcceptanceEvidence(evidence: AcceptanceCriterionEvidence[]): string {
  if (evidence.length === 0)
    return ''

  return evidence.map(item => `- [${item.status}] ${item.criterion}: ${item.evidence}`).join('\n')
}

function formatSubtaskProgress(progress: ProjectSubtaskProgress[]): string {
  if (progress.length === 0)
    return ''

  return progress.map(item => `- [${item.status}] ${item.title}${item.evidence ? `: ${item.evidence}` : ''}`).join('\n')
}

function upsertSubtaskProgress(progress: Map<string, ProjectSubtaskProgress>, item: ProjectSubtaskProgress): void {
  progress.set(normalizeCriterion(item.title), item)
}

function mergeSubtaskProgress(params: {
  managerBrief?: ProjectManagerBrief
  progress: Map<string, ProjectSubtaskProgress>
  reported?: ProjectSubtaskProgress[]
}): ProjectSubtaskProgress[] {
  for (const item of params.reported ?? []) {
    upsertSubtaskProgress(params.progress, item)
  }

  const ordered: ProjectSubtaskProgress[] = []
  for (const title of params.managerBrief?.subtasks ?? []) {
    const existing = params.progress.get(normalizeCriterion(title))
    ordered.push(existing ?? {
      title,
      status: 'todo',
    })
  }

  const knownTitles = new Set(ordered.map(item => normalizeCriterion(item.title)))
  for (const item of params.progress.values()) {
    if (!knownTitles.has(normalizeCriterion(item.title)))
      ordered.push(item)
  }

  return ordered
}

function normalizeCriterion(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function isFailingValidationSummary(summary: string | undefined): boolean {
  return !!summary && /exit code:\s*(?!0\b)\d+|timed out:\s*true|error:/i.test(summary)
}

/**
 * Reports whether the worker's final validation actually failed.
 *
 * Use when:
 * - The pre-review gate must decide validation status before spending reviewer tokens
 *
 * Expects:
 * - `validationResults` are the harness-executed final commands when present
 *
 * Returns:
 * - True when any executed command exited non-zero or timed out; falls back to parsing the
 *   text summary only when no structured results exist (for example a blocked run)
 */
function hasFailingValidation(workerResult: WorkerAgentResult): boolean {
  const results = workerResult.validationResults
  if (results && results.length > 0)
    return results.some(result => result.exitCode !== 0 || result.timedOut)

  return isFailingValidationSummary(workerResult.testSummary)
}

/**
 * Converts a failed runner tool call into model-visible feedback.
 *
 * Use when:
 * - Worker or reviewer tool calls fail because a path, search string, or command is invalid
 * - The agent should get a chance to correct the next JSON action instead of aborting the whole run
 *
 * Expects:
 * - The tool action has no partially hidden side effect beyond its own deterministic guard rails
 *
 * Returns:
 * - The successful tool output, or a compact error object safe to include in the next prompt turn
 */
async function runToolActionSafely(action: () => Promise<unknown>): Promise<unknown> {
  try {
    return await action()
  }
  catch (error) {
    return {
      error: errorMessageFrom(error) ?? 'Tool action failed.',
    }
  }
}

/**
 * Creates a deterministic review failure before the reviewer model runs.
 *
 * Use when:
 * - Worker output violates mechanical safety or evidence requirements
 * - AIRI should retry without spending reviewer tokens on obvious blockers
 *
 * Expects:
 * - `workerResult.changedFiles` are project-relative paths owned by the worker
 * - Acceptance criteria are stable strings from the work item
 *
 * Returns:
 * - A reviewer-style failure decision, or undefined when model review may proceed
 */
export function createPreReviewGateDecision(params: {
  forbiddenPathPatterns: string[]
  workItem: WorkItem
  workerResult: WorkerAgentResult
}): ReviewerAgentResult | undefined {
  const findings: ReviewerFinding[] = []
  const requiredChanges: string[] = []
  let failureKind: ReviewerAgentResult['failureKind']
  if (params.workerResult.changedFiles.length === 0) {
    failureKind ??= 'no_changes'
    findings.push({
      severity: 'blocker',
      message: 'Worker finished without changing any files.',
      requiredChange: 'Make the required project changes or explicitly block with a user-facing reason.',
    })
    requiredChanges.push('Make concrete file changes that satisfy the work item, or use blocked with a clear reason.')
  }

  const forbiddenFiles = params.workerResult.changedFiles.filter(file => !isPathAllowed(file, params.forbiddenPathPatterns))
  if (forbiddenFiles.length > 0) {
    failureKind ??= 'forbidden_path'
    findings.push({
      severity: 'blocker',
      message: `Worker changed forbidden paths: ${forbiddenFiles.join(', ')}`,
      requiredChange: 'Rework the solution without touching forbidden paths.',
    })
    requiredChanges.push(`Remove or avoid forbidden path changes: ${forbiddenFiles.join(', ')}`)
  }

  if (hasFailingValidation(params.workerResult)) {
    failureKind ??= 'validation_failed'
    findings.push({
      severity: 'blocker',
      message: 'Validation failed before reviewer model review.',
      requiredChange: 'Fix the failing validation command or explain why the project is blocked.',
    })
    requiredChanges.push('Fix failing validation before requesting another review.')
  }

  const evidenceByCriterion = new Map((params.workerResult.acceptanceEvidence ?? [])
    .map(item => [normalizeCriterion(item.criterion), item]))
  for (const criterion of params.workItem.acceptanceCriteria) {
    const evidence = evidenceByCriterion.get(normalizeCriterion(criterion))
    if (evidence && evidence.status !== 'missing' && evidence.evidence.trim())
      continue

    failureKind ??= 'missing_acceptance_evidence'
    findings.push({
      severity: 'blocker',
      message: `Missing acceptance evidence: ${criterion}`,
      requiredChange: 'Provide concrete evidence for this acceptance criterion in the final worker response.',
    })
    requiredChanges.push(`Add concrete evidence for acceptance criterion: ${criterion}`)
  }

  if (findings.length === 0)
    return undefined

  return {
    passed: false,
    comment: `Pre-review gate failed with ${findings.length} blocker(s).`,
    findings,
    requiredChanges,
    suggestedTests: [],
    acceptanceEvidence: params.workItem.acceptanceCriteria.map((criterion) => {
      const evidence = evidenceByCriterion.get(normalizeCriterion(criterion))
      return evidence ?? {
        criterion,
        evidence: '',
        status: 'missing',
      }
    }),
    confidence: 1,
    failureKind,
  }
}

type ExploreAction
  = | { action: 'list', path?: string }
    | { action: 'read', path: string }
    | { action: 'search', query: string, path?: string, regex?: boolean }
    | { action: 'find', query: string, path?: string }
    | { action: 'index', path?: string }
    | { action: 'final', summary: string }

function parseExploreAction(text: string): ExploreAction {
  const parsed = parseAgentJsonObject(text)
  const action = asString(parsed.action, 'action')
  switch (action) {
    case 'list':
      return { action, path: typeof parsed.path === 'string' ? parsed.path : undefined }
    case 'read':
      return { action, path: asString(parsed.path, 'path') }
    case 'search':
      return {
        action,
        query: asString(parsed.query, 'query'),
        path: typeof parsed.path === 'string' ? parsed.path : undefined,
        regex: parsed.regex === true,
      }
    case 'find':
      return {
        action,
        query: asString(parsed.query, 'query'),
        path: typeof parsed.path === 'string' ? parsed.path : undefined,
      }
    case 'index':
      return { action, path: typeof parsed.path === 'string' ? parsed.path : undefined }
    case 'final':
      return { action, summary: asString(parsed.summary, 'summary') }
    default:
      throw new Error(`Unsupported explore action: ${action}`)
  }
}

async function executeExploreAction(params: {
  action: Exclude<ExploreAction, { action: 'final' }>
  projectRoot: string
  settings: ProjectAgentSettings
}): Promise<unknown> {
  switch (params.action.action) {
    case 'list':
      return await listProjectDirectory({
        projectRoot: params.projectRoot,
        relativePath: params.action.path ?? '.',
        forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
      })
    case 'read':
      return await readProjectFile({
        projectRoot: params.projectRoot,
        relativePath: params.action.path,
        forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
      })
    case 'search':
      return await searchProjectFiles({
        projectRoot: params.projectRoot,
        query: params.action.query,
        relativePath: params.action.path,
        forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
        regex: params.action.regex,
      })
    case 'find':
      return await findProjectFiles({
        projectRoot: params.projectRoot,
        query: params.action.query,
        relativePath: params.action.path,
        forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
      })
    case 'index':
      return await indexProjectSymbols({
        projectRoot: params.projectRoot,
        relativePath: params.action.path,
        forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
      })
  }
}

function createExploreSystemPrompt(): string {
  return [
    'You are AIRI Explorer, a READ-ONLY code exploration sub-agent controlled through JSON actions.',
    'You cannot edit files or run shell commands. Investigate, then return one concise distilled summary.',
    'Return exactly one JSON object and no prose.',
    'Available actions:',
    '{"action":"list","path":"."}',
    '{"action":"read","path":"relative/file.ts"}',
    '{"action":"search","query":"text or regex","path":"optional/path","regex":false}',
    '{"action":"find","query":"filename-or-path-fragment","path":"optional/path"}',
    '{"action":"index","path":"optional/path"}',
    '{"action":"final","summary":"distilled findings with concrete file:line references"}',
    'Finish with final as soon as you can answer the objective. Keep the summary short and high-signal.',
  ].join('\n')
}

/**
 * Runs a bounded read-only exploration sub-agent over a clean context and returns distilled findings.
 *
 * Use when:
 * - The worker needs to investigate the codebase without polluting its own context with search churn
 *
 * Expects:
 * - `objective` is a focused, self-contained question
 * - The sub-agent only reads; it never edits files or runs shell commands
 *
 * Returns:
 * - The sub-agent's distilled summary string
 *
 * Call stack:
 *
 * runWorkerWithTools
 *   -> {@link runExploreSubAgent}
 *     -> {@link callAgentText}
 *     -> {@link executeExploreAction}
 */
export async function runExploreSubAgent(params: {
  objective: string
  fetcher?: AgentRuntimeFetch
  project: Project
  projectRoot: string
  settings: ProjectAgentSettings
}): Promise<string> {
  const messages: AgentChatMessage[] = [
    { role: 'system', content: createExploreSystemPrompt() },
    {
      role: 'user',
      content: `Project: ${params.project.name}\nExploration objective:\n${params.objective}\n\nReturn a distilled summary with concrete file:line references. Do not edit anything.`,
    },
  ]

  for (let step = 0; step < 12; step += 1) {
    const response = await callAgentText({
      config: params.settings.worker,
      messages: compactAgentMessages(messages),
      fetcher: params.fetcher,
      projectRoot: params.projectRoot,
    })
    const action = parseExploreAction(response)
    messages.push({ role: 'assistant', content: response })

    if (action.action === 'final')
      return action.summary

    const toolResult = await runToolActionSafely(async () => await executeExploreAction({
      action,
      projectRoot: params.projectRoot,
      settings: params.settings,
    }))
    messages.push({
      role: 'user',
      content: `Tool result:\n${truncateToolResult(toolResult)}`,
    })
  }

  throw new Error('Explore sub-agent did not finish within 12 tool steps.')
}

function createWorkerSystemPrompt(): string {
  return [
    'You are AIRI Worker, a coding agent controlled through JSON actions.',
    'Return exactly one JSON object and no prose.',
    'Act like a careful senior engineer: inspect before editing, keep changes scoped, run validation when possible, and preserve user work.',
    'Available actions:',
    '{"action":"list","path":"."}',
    '{"action":"read","path":"relative/file.ts"}',
    '{"action":"search","query":"text or regex","path":"optional/path","regex":false}',
    '{"action":"find","query":"filename-or-path-fragment","path":"optional/path"}',
    '{"action":"index","path":"optional/path"}',
    '{"action":"replace","path":"relative/file.ts","search":"exact text","replace":"new text","replaceAll":false}',
    '{"action":"patch","files":[{"path":"relative/file.ts","edits":[{"search":"exact text","replace":"new text","replaceAll":false}]}]}',
    '{"action":"write","path":"relative/file.ts","content":"complete UTF-8 file content"}',
    '{"action":"shell","command":"allowed command"}',
    '{"action":"status"}',
    '{"action":"diff"}',
    '{"action":"test","commands":["optional validation command"]}',
    '{"action":"explore","objective":"a focused read-only question to investigate in a clean sub-agent context"}',
    '{"action":"subtask","title":"exact subtask title","status":"todo|in_progress|done|blocked","evidence":"file/test/diff/blocker evidence"}',
    '{"action":"blocked","comment":"clear reason for the user","failureKind":"worker_blocked|validation_failed|forbidden_path|no_changes","questions":["specific question"],"subtaskProgress":[{"title":"subtask","status":"blocked","evidence":"why"}]}',
    '{"action":"final","comment":"short summary of completed work","subtaskProgress":[{"title":"subtask","status":"done","evidence":"file/test/diff evidence"}],"acceptanceEvidence":[{"criterion":"exact acceptance criterion","status":"satisfied|missing|not_applicable","evidence":"file/test/diff evidence"}]}',
    'Use read/search/find/index before replace, patch, or write. Use diff/status/test before final when useful.',
    'Use explore to delegate heavy read-only investigation to a sub-agent that returns a distilled summary, keeping your own context focused.',
    'Configured verifier commands are deterministic checks; use them as the default validation contract when they appear in the task message.',
    'Use subtask to report progress for each Project Manager subtask before and after meaningful edits.',
    'Use blocked when requirements are missing, a policy prevents a required edit, or continuing would risk user work.',
    'When blocked, include concrete questions the user can answer and a failureKind if one applies.',
    'Finish with final only after edits and validation are done or intentionally not needed.',
  ].join('\n')
}

function createWorkerTaskMessage(params: {
  attempt: number
  contextPack?: ProjectRunnerContextPack
  failureMemory?: string[]
  project: Project
  workItem: WorkItem
  managerBrief?: ProjectManagerBrief
  previousDiffSummary?: string
  previousReviewerComment?: string
  previousReviewerFeedback?: string
  settings: ProjectAgentSettings
}): AgentChatMessage {
  const verifierCommands = normalizeVerifierCommands(params.settings)
  return {
    role: 'user',
    content: [
      `Project: ${params.project.name}`,
      `Work item: ${params.workItem.identifier} ${params.workItem.title}`,
      `Goal: ${params.workItem.goal}`,
      `Acceptance criteria:\n${params.workItem.acceptanceCriteria.map(item => `- ${item}`).join('\n')}`,
      params.contextPack ? `Project context pack:\n${formatProjectRunnerContextPack(params.contextPack)}` : '',
      params.managerBrief ? `Project manager brief:\n${formatProjectManagerBrief(params.managerBrief)}` : '',
      params.managerBrief?.subtasks.length
        ? `Subtask execution contract:\n${params.managerBrief.subtasks.map(item => `- ${item}`).join('\n')}\nReport progress with {"action":"subtask",...} and include final subtaskProgress.`
        : '',
      verifierCommands.length
        ? `Configured verifier commands:\n${verifierCommands.map(item => `- ${item}`).join('\n')}`
        : '',
      `Attempt: ${params.attempt + 1}`,
      params.previousReviewerFeedback
        ? `Previous reviewer feedback:\n${params.previousReviewerFeedback}`
        : params.previousReviewerComment
          ? `Previous reviewer feedback:\n${params.previousReviewerComment}`
          : '',
      params.previousDiffSummary ? `Previous diff summary:\n${params.previousDiffSummary}` : '',
      params.failureMemory?.length ? `Failure memory:\n${params.failureMemory.map(item => `- ${item}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n'),
  }
}

async function runWorkerWithTools(params: {
  contextPack?: ProjectRunnerContextPack
  failureMemory?: string[]
  fetcher?: AgentRuntimeFetch
  project: Project
  projectRoot: string
  settings: ProjectAgentSettings
  workItem: WorkItem
  managerBrief?: ProjectManagerBrief
  attempt: number
  previousDiffSummary?: string
  previousReviewerComment?: string
  previousReviewerFeedback?: string
}): Promise<WorkerAgentResult> {
  const changedFiles = new Set<string>()
  const subtaskProgress = new Map<string, ProjectSubtaskProgress>()
  let lastTestSummary: string | undefined
  const messages: AgentChatMessage[] = [
    { role: 'system', content: createWorkerSystemPrompt() },
    createWorkerTaskMessage({
      ...params,
      contextPack: params.contextPack,
      failureMemory: params.failureMemory,
      managerBrief: params.managerBrief,
    }),
  ]

  for (let step = 0; step < 30; step += 1) {
    const response = await callAgentText({
      config: params.settings.worker,
      // Clear stale tool outputs before each step so a long loop does not rot its own context.
      messages: compactAgentMessages(messages),
      fetcher: params.fetcher,
      projectRoot: params.projectRoot,
    })
    const action = parseWorkerAction(response)
    messages.push({ role: 'assistant', content: response })

    if (action.action === 'blocked') {
      const mergedSubtaskProgress = mergeSubtaskProgress({
        managerBrief: params.managerBrief,
        progress: subtaskProgress,
        reported: action.subtaskProgress,
      })
      if (params.project.gitEnabled) {
        for (const file of await getGitChangedFiles(params.projectRoot)) {
          changedFiles.add(file)
        }
      }
      const diffSummary = params.project.gitEnabled
        ? await getAgentDiffSummary(params.projectRoot, [...changedFiles])
        : [...changedFiles].join('\n')
      return {
        changedFiles: [...changedFiles],
        comment: action.comment,
        diffSummary,
        testSummary: lastTestSummary,
        blockedReason: action.comment,
        blockedQuestions: action.questions,
        failureKind: action.failureKind ?? 'worker_blocked',
        subtaskProgress: mergedSubtaskProgress,
      }
    }

    if (action.action === 'final') {
      const mergedSubtaskProgress = mergeSubtaskProgress({
        managerBrief: params.managerBrief,
        progress: subtaskProgress,
        reported: action.subtaskProgress,
      })
      if (params.project.gitEnabled) {
        for (const file of await getGitChangedFiles(params.projectRoot)) {
          changedFiles.add(file)
        }
      }
      const diffSummary = params.project.gitEnabled
        ? await getAgentDiffSummary(params.projectRoot, [...changedFiles])
        : [...changedFiles].join('\n')
      const testResult = await runProjectTestCommand({
        changedFiles: [...changedFiles],
        projectRoot: params.projectRoot,
        settings: params.settings,
        configuredCommand: params.project.testCommand,
        suggestedCommands: params.managerBrief?.suggestedTests,
      })
      return {
        changedFiles: [...changedFiles],
        acceptanceEvidence: action.acceptanceEvidence,
        comment: action.comment,
        diffSummary,
        subtaskProgress: mergedSubtaskProgress,
        // Structured exit codes from the harness-executed final validation, trusted by the gate/reviewer.
        validationResults: testResult.commands,
        testSummary: [
          lastTestSummary ? `Worker-requested validation:\n${lastTestSummary}` : '',
          `Final validation:\n${testResult.summary}`,
        ].filter(Boolean).join('\n\n'),
      }
    }

    if (action.action === 'subtask') {
      upsertSubtaskProgress(subtaskProgress, {
        title: action.title,
        status: action.status,
        evidence: action.evidence,
      })
      messages.push({
        role: 'user',
        content: `Tool result:\n${truncateToolResult({
          subtaskProgress: mergeSubtaskProgress({
            managerBrief: params.managerBrief,
            progress: subtaskProgress,
          }),
        })}`,
      })
      continue
    }

    if (action.action === 'explore') {
      // Offload read-only investigation to a sub-agent so search churn never enters the worker context.
      const summary = await runToolActionSafely(async () => await runExploreSubAgent({
        objective: action.objective,
        fetcher: params.fetcher,
        project: params.project,
        projectRoot: params.projectRoot,
        settings: params.settings,
      }))
      messages.push({
        role: 'user',
        content: `Explore result:\n${truncateToolResult(summary)}`,
      })
      continue
    }

    const toolResult = await runToolActionSafely(async () => await executeWorkerAction({
      action,
      changedFiles,
      managerBrief: params.managerBrief,
      project: params.project,
      projectRoot: params.projectRoot,
      settings: params.settings,
    }))
    if (action.action === 'test' && isRecord(toolResult) && typeof toolResult.summary === 'string')
      lastTestSummary = toolResult.summary
    messages.push({
      role: 'user',
      content: `Tool result:\n${truncateToolResult(toolResult)}`,
    })
  }

  throw new Error('Worker agent did not finish within 30 tool steps.')
}

async function syncGitChangedFiles(params: {
  changedFiles: Set<string>
  project: Project
  projectRoot: string
}): Promise<void> {
  if (!params.project.gitEnabled)
    return

  for (const file of await getGitChangedFiles(params.projectRoot)) {
    params.changedFiles.add(file)
  }
}

async function executeWorkerAction(params: {
  action: Exclude<WorkerAction, { action: 'blocked' } | { action: 'final' } | { action: 'subtask' } | { action: 'explore' }>
  changedFiles: Set<string>
  managerBrief?: ProjectManagerBrief
  project: Project
  projectRoot: string
  settings: ProjectAgentSettings
}): Promise<unknown> {
  switch (params.action.action) {
    case 'list':
      return await listProjectDirectory({
        projectRoot: params.projectRoot,
        relativePath: params.action.path ?? '.',
        forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
      })
    case 'read':
      return await readProjectFile({
        projectRoot: params.projectRoot,
        relativePath: params.action.path,
        forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
      })
    case 'search':
      return await searchProjectFiles({
        projectRoot: params.projectRoot,
        query: params.action.query,
        relativePath: params.action.path,
        forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
        regex: params.action.regex,
      })
    case 'find':
      return await findProjectFiles({
        projectRoot: params.projectRoot,
        query: params.action.query,
        relativePath: params.action.path,
        forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
      })
    case 'index':
      return await indexProjectSymbols({
        projectRoot: params.projectRoot,
        relativePath: params.action.path,
        forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
      })
    case 'replace': {
      const result = await replaceInProjectFile({
        projectRoot: params.projectRoot,
        relativePath: params.action.path,
        search: params.action.search,
        replace: params.action.replace,
        replaceAll: params.action.replaceAll,
        forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
      })
      params.changedFiles.add(result.path)
      return result
    }
    case 'patch': {
      const result = await applyStructuredProjectPatch({
        projectRoot: params.projectRoot,
        files: params.action.files,
        forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
      })
      for (const file of result.changedFiles) {
        params.changedFiles.add(file)
      }
      return result
    }
    case 'write': {
      const result = await writeProjectFile({
        projectRoot: params.projectRoot,
        relativePath: params.action.path,
        content: params.action.content,
        forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
      })
      params.changedFiles.add(result.path)
      return result
    }
    case 'shell': {
      const result = await runProjectShellCommand({
        projectRoot: params.projectRoot,
        command: params.action.command,
        settings: params.settings,
      })
      await syncGitChangedFiles({
        changedFiles: params.changedFiles,
        project: params.project,
        projectRoot: params.projectRoot,
      })
      return result
    }
    case 'status':
      return {
        changedFiles: params.project.gitEnabled
          ? await getGitChangedFiles(params.projectRoot)
          : [...params.changedFiles],
      }
    case 'diff': {
      const changedFiles = params.project.gitEnabled
        ? await getGitChangedFiles(params.projectRoot)
        : [...params.changedFiles]
      return {
        changedFiles,
        summary: params.project.gitEnabled
          ? await getAgentDiffSummary(params.projectRoot, changedFiles)
          : changedFiles.join('\n'),
      }
    }
    case 'test':
      await syncGitChangedFiles({
        changedFiles: params.changedFiles,
        project: params.project,
        projectRoot: params.projectRoot,
      })
      return await runProjectTestCommand({
        changedFiles: [...params.changedFiles],
        projectRoot: params.projectRoot,
        settings: params.settings,
        configuredCommand: params.project.testCommand,
        suggestedCommands: [
          ...(params.action.commands ?? []),
          ...(params.managerBrief?.suggestedTests ?? []),
        ],
      })
  }
}

async function executeReviewerAction(params: {
  action: Exclude<ReviewerAction, { action: 'final' }>
  managerBrief?: ProjectManagerBrief
  project: Project
  projectRoot: string
  settings: ProjectAgentSettings
  workerResult: WorkerAgentResult
}): Promise<unknown> {
  switch (params.action.action) {
    case 'list':
      return await listProjectDirectory({
        projectRoot: params.projectRoot,
        relativePath: params.action.path ?? '.',
        forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
      })
    case 'read':
      return await readProjectFile({
        projectRoot: params.projectRoot,
        relativePath: params.action.path,
        forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
      })
    case 'search':
      return await searchProjectFiles({
        projectRoot: params.projectRoot,
        query: params.action.query,
        relativePath: params.action.path,
        forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
        regex: params.action.regex,
      })
    case 'find':
      return await findProjectFiles({
        projectRoot: params.projectRoot,
        query: params.action.query,
        relativePath: params.action.path,
        forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
      })
    case 'index':
      return await indexProjectSymbols({
        projectRoot: params.projectRoot,
        relativePath: params.action.path,
        forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
      })
    case 'status':
      return {
        changedFiles: params.project.gitEnabled
          ? await getGitChangedFiles(params.projectRoot)
          : params.workerResult.changedFiles,
      }
    case 'diff': {
      const changedFiles = params.project.gitEnabled
        ? await getGitChangedFiles(params.projectRoot)
        : params.workerResult.changedFiles
      return {
        changedFiles,
        summary: params.project.gitEnabled
          ? await getAgentDiffSummary(params.projectRoot, changedFiles)
          : params.workerResult.diffSummary,
      }
    }
    case 'test':
      return await runProjectTestCommand({
        changedFiles: params.workerResult.changedFiles,
        projectRoot: params.projectRoot,
        settings: params.settings,
        configuredCommand: params.project.testCommand,
        suggestedCommands: [
          ...(params.action.commands ?? []),
          ...(params.managerBrief?.suggestedTests ?? []),
        ],
      })
  }
}

function createReviewerSystemPrompt(lens: 'default' | 'refute' = 'default'): string {
  return [
    'You are AIRI Reviewer, a strict code reviewer controlled through JSON actions.',
    'Do not pass unless every acceptance criterion is satisfied or clearly not applicable with evidence.',
    ...(lens === 'refute'
      ? ['Adversarial pass: assume the change is WRONG. Actively hunt for an acceptance criterion it fails or a regression it introduces, and only pass if after a genuine attempt to refute you cannot find any blocking issue.']
      : []),
    'Use the reviewer evidence pack first: changed files, worker evidence, source symbols/imports, diff summary, and validation summary are pre-collected for you.',
    'Trust the "Executed validation (trusted exit codes)" section as ground truth; treat worker acceptance claims and worker comments as unverified and re-derive each acceptance criterion from the diff and the executed exit codes.',
    'Treat configured verifier command failures as blockers unless the work item explicitly makes them irrelevant.',
    'Use tools to inspect actual files, symbols, diffs, status, and validation results before final when evidence is thin.',
    'Available actions:',
    '{"action":"list","path":"."}',
    '{"action":"read","path":"relative/file.ts"}',
    '{"action":"search","query":"text or regex","path":"optional/path","regex":false}',
    '{"action":"find","query":"filename-or-path-fragment","path":"optional/path"}',
    '{"action":"index","path":"optional/path"}',
    '{"action":"status"}',
    '{"action":"diff"}',
    '{"action":"test","commands":["optional validation command"]}',
    '{"action":"final","passed":true,"comment":"short review result","failureKind":"review_rejected|validation_failed|missing_acceptance_evidence","findings":[],"requiredChanges":[],"suggestedTests":[],"acceptanceEvidence":[{"criterion":"exact acceptance criterion","status":"satisfied|missing|not_applicable","evidence":"file/test/diff evidence"}],"confidence":0.0}',
    'Return exactly one JSON object and no prose.',
  ].join('\n')
}

async function runReviewerAgent(params: {
  contextPack?: ProjectRunnerContextPack
  fetcher?: AgentRuntimeFetch
  managerBrief?: ProjectManagerBrief
  project: Project
  projectRoot: string
  settings: ProjectAgentSettings
  workItem: WorkItem
  workerResult: WorkerAgentResult
  lens?: 'default' | 'refute'
}): Promise<ReviewerAgentResult> {
  const evidencePack = await buildProjectReviewerEvidencePack({
    forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
    projectRoot: params.projectRoot,
    workerResult: params.workerResult,
  })
  const messages: AgentChatMessage[] = [{
    role: 'system',
    content: createReviewerSystemPrompt(params.lens),
  }, {
    role: 'user',
    content: [
      `Project: ${params.project.name}`,
      `Work item: ${params.workItem.identifier} ${params.workItem.title}`,
      `Goal: ${params.workItem.goal}`,
      `Acceptance criteria:\n${params.workItem.acceptanceCriteria.map(item => `- ${item}`).join('\n')}`,
      params.contextPack ? `Project context pack:\n${formatProjectRunnerContextPack(params.contextPack)}` : '',
      params.managerBrief ? `Project manager brief:\n${formatProjectManagerBrief(params.managerBrief)}` : '',
      `Worker comment:\n${params.workerResult.comment}`,
      params.workerResult.subtaskProgress?.length ? `Worker subtask progress:\n${formatSubtaskProgress(params.workerResult.subtaskProgress)}` : '',
      `Worker acceptance evidence:\n${formatAcceptanceEvidence(params.workerResult.acceptanceEvidence ?? []) || '(none)'}`,
      `Reviewer evidence pack:\n${formatProjectReviewerEvidencePack(evidencePack)}`,
      `Diff summary:\n${params.workerResult.diffSummary || '(no diff summary)'}`,
      params.workerResult.testSummary ? `Test summary:\n${params.workerResult.testSummary}` : '',
      'If you reject, make requiredChanges concrete enough for the next worker attempt.',
    ].filter(Boolean).join('\n\n'),
  }]

  for (let step = 0; step < 20; step += 1) {
    const response = await callAgentText({
      config: params.settings.reviewer,
      // Clear stale tool outputs before each step so a long loop does not rot its own context.
      messages: compactAgentMessages(messages),
      fetcher: params.fetcher,
      projectRoot: params.projectRoot,
    })
    const action = parseReviewerAction(response)
    messages.push({ role: 'assistant', content: response })

    if (action.action === 'final')
      return action.decision

    const toolResult = await runToolActionSafely(async () => await executeReviewerAction({
      action,
      managerBrief: params.managerBrief,
      project: params.project,
      projectRoot: params.projectRoot,
      settings: params.settings,
      workerResult: params.workerResult,
    }))
    messages.push({
      role: 'user',
      content: `Reviewer tool result:\n${truncateToolResult(toolResult)}`,
    })
  }

  throw new Error('Reviewer agent did not finish within 20 tool steps.')
}

/**
 * Combines a passing primary review with an adversarial refutation pass, failing closed on disagreement.
 *
 * Use when:
 * - Adversarial review is enabled and the primary reviewer already passed
 *
 * Expects:
 * - `primary.passed` is true; `refuter` is a second review of the same change run with the refutation lens
 *
 * Returns:
 * - `primary` unchanged when the refuter also passes; otherwise a merged rejection carrying both
 *   reviewers' findings and required changes so the next worker attempt sees every blocker
 */
export function combineAdversarialReview(primary: ReviewerAgentResult, refuter: ReviewerAgentResult): ReviewerAgentResult {
  if (refuter.passed)
    return primary

  const dedupe = (values: string[]): string[] => [...new Set(values.filter(Boolean))]
  return {
    passed: false,
    comment: `Adversarial review rejected an otherwise-passing change.\nPrimary: ${primary.comment}\nRefutation: ${refuter.comment}`,
    findings: [...(primary.findings ?? []), ...(refuter.findings ?? [])],
    requiredChanges: dedupe([...(primary.requiredChanges ?? []), ...(refuter.requiredChanges ?? [])]),
    suggestedTests: dedupe([...(primary.suggestedTests ?? []), ...(refuter.suggestedTests ?? [])]),
    acceptanceEvidence: refuter.acceptanceEvidence ?? primary.acceptanceEvidence,
    confidence: refuter.confidence,
    failureKind: refuter.failureKind ?? 'review_rejected',
  }
}

/**
 * Asks the project manager model for a worker/reviewer execution brief.
 *
 * Use when:
 * - A configured project manager should shape the run before Worker edits start
 * - Worker and Reviewer should share the same plan, risks, and review focus
 *
 * Expects:
 * - The model returns the requested JSON object
 * - Empty manager model ids mean project-manager planning is disabled
 *
 * Returns:
 * - A normalized brief, or undefined when the role is not configured
 *
 * Call stack:
 *
 * runProjectWorkItem
 *   -> {@link runProjectManagerAgent}
 *     -> {@link callAgentText}
 *       -> project manager provider chat completions
 */
async function runProjectManagerAgent(params: {
  contextPack?: ProjectRunnerContextPack
  fetcher?: AgentRuntimeFetch
  project: Project
  projectRoot: string
  settings: ProjectAgentSettings
  workItem: WorkItem
}): Promise<ProjectManagerBrief | undefined> {
  if (!params.settings.projectManager.model.trim())
    return undefined

  const verifierCommands = normalizeVerifierCommands(params.settings)
  const response = await callAgentText({
    config: params.settings.projectManager,
    messages: [{
      role: 'user',
      content: [
        'Return exactly JSON with this shape:',
        '{"summary":"short execution summary","likelyFiles":["path or glob"],"implementationPlan":["step"],"subtasks":["small ordered task"],"riskNotes":["risk"],"reviewFocus":["focus"],"suggestedTests":["test command or check"],"openQuestions":["question only if truly blocking"]}',
        `Project: ${params.project.name}`,
        `Work item: ${params.workItem.identifier} ${params.workItem.title}`,
        `Goal: ${params.workItem.goal}`,
        `Acceptance criteria:\n${params.workItem.acceptanceCriteria.map(item => `- ${item}`).join('\n')}`,
        verifierCommands.length ? `Configured verifier commands:\n${verifierCommands.map(item => `- ${item}`).join('\n')}` : '',
        params.contextPack ? `Project context pack:\n${formatProjectRunnerContextPack(params.contextPack)}` : '',
        'Do not edit files. Prepare the brief for a coding worker and strict reviewer.',
        'Break large work into small subtasks. Include likely files, validation commands, and review focus.',
      ].join('\n\n'),
    }],
    fetcher: params.fetcher,
    projectRoot: params.projectRoot,
  })

  return parseProjectManagerBrief(response)
}

function lifecycleStatusForWorkItemStatus(status: WorkItem['status']): WorkItemRunLifecycleStatus {
  switch (status) {
    case 'blocked':
      return 'blocked'
    case 'done':
      return 'completed'
    case 'in_review':
      return 'reviewing'
    case 'todo':
      return 'queued'
    case 'in_progress':
      return 'working'
  }
}

/**
 * Runs one work item through AIRI's isolated worker/reviewer pipeline.
 *
 * Use when:
 * - A TODO work item is started from chat or the localhost board
 * - Git-backed projects should be edited in a separate worktree
 *
 * Expects:
 * - The caller has already checked required work item fields
 * - The caller has already handled dirty original worktree confirmation
 *
 * Returns:
 * - Promise that resolves after review, optional commit, and cleanup finish
 *
 * Call stack:
 *
 * setupProjectManagementService (../project-management)
 *   -> {@link runProjectWorkItem}
 *     -> {@link createAgentWorktree}
 *       -> {@link runProjectReviewLoop}
 *         -> worker JSON tool loop
 *         -> reviewer JSON decision
 */
export async function runProjectWorkItem(params: {
  fetcher?: AgentRuntimeFetch
  generateId: () => string
  now: () => number
  project: Project
  settings: ProjectAgentSettings
  store: ProjectRunnerStore
  workItem: WorkItem
}): Promise<void> {
  const runId = params.generateId()
  let activeProjectRoot = params.project.rootPath
  let contextPack: ProjectRunnerContextPack | undefined
  let managerBrief: ProjectManagerBrief | undefined
  let worktree: { branchName: string, path: string } | undefined
  let shouldRemoveWorktree = true
  const startedAt = params.now()
  let runRecord: WorkItemRunRecord = {
    id: runId,
    workItemId: params.workItem.id,
    status: 'queued',
    lifecycleStatus: 'queued',
    attempt: 0,
    changedFiles: [],
    worktreeState: 'none',
    startedAt,
    lastActivityAt: startedAt,
  }

  const upsertRun = (patch: Partial<WorkItemRunRecord>) => {
    runRecord = {
      ...runRecord,
      status: patch.status ?? runRecord.status,
      lifecycleStatus: patch.lifecycleStatus ?? runRecord.lifecycleStatus,
      attempt: patch.attempt ?? runRecord.attempt,
      changedFiles: patch.changedFiles ?? runRecord.changedFiles,
      worktreeState: patch.worktreeState ?? runRecord.worktreeState,
      worktreePath: patch.worktreePath ?? runRecord.worktreePath ?? worktree?.path,
      branchName: patch.branchName ?? runRecord.branchName ?? worktree?.branchName,
      planSummary: patch.planSummary ?? runRecord.planSummary,
      planSteps: patch.planSteps ?? runRecord.planSteps,
      riskNotes: patch.riskNotes ?? runRecord.riskNotes,
      reviewFocus: patch.reviewFocus ?? runRecord.reviewFocus,
      verificationCommands: patch.verificationCommands ?? runRecord.verificationCommands,
      subtaskProgress: patch.subtaskProgress ?? runRecord.subtaskProgress,
      diffSummary: patch.diffSummary ?? runRecord.diffSummary,
      workerComment: patch.workerComment ?? runRecord.workerComment,
      reviewerComment: patch.reviewerComment ?? runRecord.reviewerComment,
      testCommand: patch.testCommand ?? runRecord.testCommand,
      testSummary: patch.testSummary ?? runRecord.testSummary,
      commitHash: patch.commitHash ?? runRecord.commitHash,
      commitMessage: patch.commitMessage ?? runRecord.commitMessage,
      error: patch.error ?? runRecord.error,
      startedAt,
      lastActivityAt: patch.lastActivityAt ?? params.now(),
      finishedAt: patch.finishedAt ?? runRecord.finishedAt,
    }
    params.store.upsertRunRecord(runRecord)
  }

  try {
    if (params.project.gitEnabled) {
      worktree = await createAgentWorktree({
        projectRoot: params.project.rootPath,
        workItem: params.workItem,
        branchName: buildAgentRunWorktreeBranchName(params.workItem, runId),
        worktreePath: buildAgentRunWorktreePath(params.project.rootPath, params.workItem, runId),
      })
      activeProjectRoot = worktree.path
      upsertRun({
        worktreePath: worktree.path,
        branchName: worktree.branchName,
        worktreeState: 'active',
      })
      params.store.addComment({
        workItemId: params.workItem.id,
        actorType: 'system',
        kind: 'status',
        content: `일감 worktree를 만들었어: ${worktree.path} (${worktree.branchName})`,
      })
    }

    upsertRun({
      status: 'in_progress',
      lifecycleStatus: 'planning',
      verificationCommands: buildRunVerificationCommands({
        settings: params.settings,
      }),
      worktreePath: worktree?.path,
      branchName: worktree?.branchName,
      worktreeState: worktree ? 'active' : 'none',
    })

    try {
      contextPack = await buildProjectRunnerContextPack({
        forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
        project: params.project,
        projectRoot: activeProjectRoot,
        source: params.store.getSnapshot?.(),
        workItem: params.workItem,
      })
      if (contextPack.warnings.length > 0) {
        params.store.addComment({
          workItemId: params.workItem.id,
          actorType: 'system',
          kind: 'status',
          content: `Runner context 일부를 수집하지 못했어:\n${contextPack.warnings.map(item => `- ${item}`).join('\n')}`,
        })
      }
    }
    catch (error) {
      params.store.addComment({
        workItemId: params.workItem.id,
        actorType: 'system',
        kind: 'status',
        content: `Runner context 수집에 실패했지만 워커 실행은 계속할게: ${errorMessageFrom(error) ?? 'unknown error'}`,
      })
    }

    try {
      managerBrief = await runProjectManagerAgent({
        contextPack,
        fetcher: params.fetcher,
        project: params.project,
        projectRoot: activeProjectRoot,
        settings: params.settings,
        workItem: params.workItem,
      })
      if (managerBrief) {
        upsertRun({
          planSummary: managerBrief.summary,
          planSteps: managerBrief.implementationPlan,
          riskNotes: managerBrief.riskNotes,
          reviewFocus: managerBrief.reviewFocus,
          verificationCommands: buildRunVerificationCommands({
            managerBrief,
            settings: params.settings,
          }),
        })
        params.store.addComment({
          workItemId: params.workItem.id,
          actorType: 'system',
          kind: 'status',
          content: `Project Manager brief:\n${formatProjectManagerBrief(managerBrief)}`,
        })
      }
    }
    catch (error) {
      params.store.addComment({
        workItemId: params.workItem.id,
        actorType: 'system',
        kind: 'status',
        content: `Project Manager 브리프 생성에 실패했지만 워커 실행은 계속할게: ${errorMessageFrom(error) ?? 'unknown error'}`,
      })
    }

    const reviewResult = await runProjectReviewLoop({
      project: params.project,
      workItem: params.workItem,
      settings: params.settings,
      runWorker: async input => await runWorkerWithTools({
        contextPack,
        failureMemory: input.failureMemory,
        fetcher: params.fetcher,
        project: params.project,
        projectRoot: activeProjectRoot,
        settings: params.settings,
        workItem: params.workItem,
        managerBrief,
        attempt: input.attempt,
        previousReviewerComment: input.previousReviewerComment,
        previousReviewerFeedback: input.previousReviewerFeedback,
        previousDiffSummary: input.previousDiffSummary,
      }),
      runReviewer: async (input) => {
        const gateDecision = createPreReviewGateDecision({
          forbiddenPathPatterns: params.settings.forbiddenPathPatterns,
          workItem: params.workItem,
          workerResult: input.workerResult,
        })
        if (gateDecision)
          return gateDecision

        const primary = await runReviewerAgent({
          contextPack,
          fetcher: params.fetcher,
          project: params.project,
          projectRoot: activeProjectRoot,
          settings: params.settings,
          workItem: params.workItem,
          managerBrief,
          workerResult: input.workerResult,
          lens: 'default',
        })
        // Adversarial second pass (opt-in): only re-check a PASS, and require both reviewers to agree.
        if (!primary.passed || !params.settings.adversarialReview)
          return primary

        const refuter = await runReviewerAgent({
          contextPack,
          fetcher: params.fetcher,
          project: params.project,
          projectRoot: activeProjectRoot,
          settings: params.settings,
          workItem: params.workItem,
          managerBrief,
          workerResult: input.workerResult,
          lens: 'refute',
        })
        return combineAdversarialReview(primary, refuter)
      },
      failureMemory: contextPack?.failureMemory,
      updateStatus: async (status) => {
        params.store.updateWorkItem({
          id: params.workItem.id,
          patch: { status },
        })
        upsertRun({
          status: status === 'in_progress' || status === 'in_review' || status === 'done' || status === 'blocked'
            ? status
            : 'in_progress',
          lifecycleStatus: lifecycleStatusForWorkItemStatus(status),
        })
      },
      addComment: async (actorType, kind, content) => {
        params.store.addComment({
          workItemId: params.workItem.id,
          actorType,
          kind,
          content,
        })
      },
      revertChanges: async (changedFiles) => {
        if (worktree) {
          const revertedWorktree = worktree
          await removeAgentWorktree(params.project.rootPath, revertedWorktree.path)
          worktree = undefined
          upsertRun({ worktreeState: 'removed' })
          return
        }
        if (params.project.gitEnabled)
          await revertAgentChangedFiles(activeProjectRoot, changedFiles)
      },
    })

    let commitHash: string | undefined
    let commitMessage: string | undefined
    let finalRunStatus: WorkItemRunRecord['status'] = reviewResult.passed ? 'done' : 'blocked'
    let finalError: string | undefined = reviewResult.blockedReason
      ? `[${reviewResult.failureKind ?? 'worker_blocked'}] ${reviewResult.blockedReason}`
      : undefined
    if (!reviewResult.passed && !finalError) {
      const classification = classifyProjectRunnerFailure({
        changedFiles: reviewResult.changedFiles,
        reviewComment: reviewResult.reviewerComment,
        runStatus: 'blocked',
      })
      finalError = `[${reviewResult.failureKind ?? classification?.kind ?? 'review_rejected'}] ${classification?.summary ?? 'Review failed after maximum retries.'}`
    }
    if (reviewResult.passed && params.project.gitEnabled && !params.settings.autoCommit && worktree) {
      shouldRemoveWorktree = false
      upsertRun({
        worktreeState: 'preserved',
      })
      params.store.addComment({
        workItemId: params.workItem.id,
        actorType: 'system',
        kind: 'commit',
        content: `자동 커밋이 꺼져 있어서 변경사항을 ${worktree.path} worktree에 보존했어.`,
      })
    }

    if (reviewResult.passed && params.project.gitEnabled && params.settings.autoCommit) {
      upsertRun({
        lifecycleStatus: 'integrating',
      })
      const commit = await commitAgentChangedFiles({
        projectRoot: activeProjectRoot,
        files: reviewResult.changedFiles,
        workItem: params.workItem,
      })
      commitHash = commit.hash
      commitMessage = commit.message
      params.store.addComment({
        workItemId: params.workItem.id,
        actorType: 'system',
        kind: 'commit',
        content: commit.committed
          ? `자동 커밋 완료: ${commit.message}${commit.hash ? ` (${commit.hash})` : ''}`
          : `커밋 실패: ${commit.error ?? commit.message}`,
      })

      if (!commit.committed && worktree && reviewResult.changedFiles.length > 0) {
        shouldRemoveWorktree = false
        upsertRun({
          worktreeState: 'preserved',
        })
        params.store.addComment({
          workItemId: params.workItem.id,
          actorType: 'system',
          kind: 'commit',
          content: `커밋되지 않은 변경사항을 잃지 않도록 ${worktree.path} worktree를 보존했어.`,
        })
      }

      if (commit.committed && worktree) {
        const integration = await integrateAgentBranchIntoProject({
          projectRoot: params.project.rootPath,
          branchName: worktree.branchName,
        })

        params.store.addComment({
          workItemId: params.workItem.id,
          actorType: 'system',
          kind: 'commit',
          content: integration.integrated
            ? integration.skipped
              ? `원본 프로젝트에 동일한 변경이 이미 반영되어 있어서 ${worktree.branchName} cherry-pick을 건너뛰었어${integration.hash ? `: ${integration.hash}` : '.'}`
              : `원본 프로젝트에 에이전트 커밋을 반영했어${integration.hash ? `: ${integration.hash}` : '.'}`
            : integration.conflict
              ? `원본 프로젝트 반영 중 충돌이 발생했어. ${worktree.branchName} 브랜치를 보존했으니 충돌을 수동으로 확인해줘.\n${integration.error ?? ''}`.trim()
              : `원본 프로젝트에 자동 반영하지 않았어. ${worktree.branchName} 브랜치를 보존했어.\n${integration.error ?? ''}`.trim(),
        })

        if (!integration.integrated) {
          shouldRemoveWorktree = false
          finalRunStatus = 'blocked'
          finalError = `[integration_failed] ${integration.error ?? 'Agent branch integration failed.'}`
          upsertRun({
            lifecycleStatus: 'blocked',
            worktreeState: 'preserved',
          })
          params.store.updateWorkItem({
            id: params.workItem.id,
            patch: { status: 'blocked' },
          })
          params.store.addComment({
            workItemId: params.workItem.id,
            actorType: 'system',
            kind: 'status',
            content: `수동 통합이 필요해서 일감을 blocked로 표시했어. worktree는 ${worktree.path}에 보존했어.`,
          })
        }
      }
    }

    upsertRun({
      status: finalRunStatus,
      lifecycleStatus: finalRunStatus === 'done' ? 'completed' : 'blocked',
      attempt: reviewResult.attempts,
      changedFiles: reviewResult.changedFiles,
      subtaskProgress: reviewResult.subtaskProgress,
      reviewerComment: reviewResult.reviewerComment,
      commitHash,
      commitMessage,
      error: finalError,
      worktreeState: worktree
        ? shouldRemoveWorktree ? runRecord.worktreeState : 'preserved'
        : runRecord.worktreeState,
      finishedAt: params.now(),
    })
  }
  catch (error) {
    const message = errorMessageFrom(error) ?? 'Project work item runner failed.'
    const classification = classifyProjectRunnerFailure({
      error: message,
      runStatus: 'blocked',
    })
    params.store.addComment({
      workItemId: params.workItem.id,
      actorType: 'system',
      kind: 'status',
      content: `작업 실행 실패: ${message}\n분류: ${classification?.kind ?? 'agent_error'}`,
    })
    params.store.updateWorkItem({
      id: params.workItem.id,
      patch: { status: 'blocked' },
    })
    upsertRun({
      status: 'blocked',
      lifecycleStatus: 'blocked',
      error: `[${classification?.kind ?? 'agent_error'}] ${message}`,
      finishedAt: params.now(),
    })

    if (worktree) {
      const failedWorktree = worktree
      worktree = undefined
      await removeAgentWorktree(params.project.rootPath, failedWorktree.path)
        .then(() => upsertRun({ worktreeState: 'removed' }))
        .catch(() => upsertRun({ worktreeState: 'preserved' }))
    }
  }
  finally {
    if (worktree && params.project.gitEnabled && shouldRemoveWorktree) {
      await removeAgentWorktree(params.project.rootPath, worktree.path)
        .then(() => upsertRun({ worktreeState: 'removed' }))
        .catch(() => upsertRun({ worktreeState: 'preserved' }))
    }
  }
}
