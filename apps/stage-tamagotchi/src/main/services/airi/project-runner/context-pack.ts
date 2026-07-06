import type {
  Project,
  WorkItem,
  WorkItemComment,
  WorkItemRunRecord,
} from '@proj-airi/stage-projects'

import type { ProjectDirectoryEntry, ProjectSymbolEntry } from './tools'

import { errorMessageFrom } from '@moeru/std'

import { getGitChangedFiles } from './git'
import { recommendProjectTestCommands } from './tests'
import { indexProjectSymbols, listProjectDirectory, readProjectFile } from './tools'

/**
 * Snapshot data the runner can use without coupling itself to the main store.
 */
export interface ProjectRunnerContextSource {
  /** Current project-management work items. */
  workItems?: WorkItem[]
  /** Current project-management comments. */
  comments?: WorkItemComment[]
  /** Current project-management run records. */
  runs?: WorkItemRunRecord[]
}

/**
 * Compact project context shared by manager, worker, and reviewer agents.
 */
export interface ProjectRunnerContextPack {
  /** Root directory entries visible to the agent. */
  rootEntries: ProjectDirectoryEntry[]
  /** Lightweight symbol index for common source files. */
  symbols: ProjectSymbolEntry[]
  /** Scripts read from package.json when available. */
  packageScripts: Array<{ name: string, command: string }>
  /** Validation commands inferred from project files. */
  recommendedTests: Array<{ command: string, reason: string }>
  /** Nearby work items in the same project. */
  relatedWorkItems: Array<Pick<WorkItem, 'identifier' | 'status' | 'title'>>
  /** Most recent comments attached to this work item. */
  recentComments: Array<Pick<WorkItemComment, 'actorType' | 'content' | 'kind'>>
  /** Recent runner attempts for this work item. */
  recentRuns: Array<Pick<WorkItemRunRecord, 'attempt' | 'changedFiles' | 'error' | 'lifecycleStatus' | 'planSummary' | 'reviewerComment' | 'status' | 'subtaskProgress' | 'testSummary' | 'workerComment'>>
  /** Lessons from blocked runs, failed tests, or reviewer feedback. */
  failureMemory: string[]
  /** Dirty files currently visible in the active project root/worktree. */
  gitChangedFiles: string[]
  /** Non-fatal collection failures that agents should treat as missing context. */
  warnings: string[]
}

function sortByLatestRun(a: WorkItemRunRecord, b: WorkItemRunRecord): number {
  return (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt)
}

function sortByNewestComment(a: WorkItemComment, b: WorkItemComment): number {
  return b.createdAt - a.createdAt
}

function formatCommentMemory(comment: WorkItemComment): string {
  return `${comment.actorType}/${comment.kind}: ${comment.content}`
}

function isMissingFileError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

function isFailureLikeText(text: string | undefined): boolean {
  return !!text && /block|fail|error|exit code:\s*(?!0\b)\d+|timed out:\s*true|실패|블락|문제|충돌/i.test(text)
}

function formatRunMemory(run: WorkItemRunRecord): string | undefined {
  const failureLikeTestSummary = isFailureLikeText(run.testSummary) ? run.testSummary : undefined
  if (run.status !== 'blocked' && !run.error && !isFailureLikeText(run.reviewerComment) && !failureLikeTestSummary)
    return undefined

  return [
    `run status=${run.status}`,
    run.error ? `error=${run.error}` : '',
    isFailureLikeText(run.reviewerComment) ? `review=${run.reviewerComment}` : '',
    failureLikeTestSummary ? `tests=${failureLikeTestSummary.split(/\r?\n/).slice(0, 4).join(' | ')}` : '',
  ].filter(Boolean).join('; ')
}

/**
 * Distills raw failure notes into a compact, de-duplicated lesson list.
 *
 * Before:
 * - ["run status=blocked; error=X", "run status=blocked; error=X", "   ", "<800-char reviewer dump>"]
 *
 * After:
 * - ["run status=blocked; error=X", "<800-char reviewer dump truncated to 300> ..."]
 */
export function distillFailureMemory(entries: string[], maxEntries = 12, maxEntryLength = 300): string[] {
  const seen = new Set<string>()
  const distilled: string[] = []
  for (const raw of entries) {
    const trimmed = raw.trim()
    if (trimmed.length === 0)
      continue

    // Normalize whitespace and case for the dedup key only, so near-identical repeats collapse.
    const key = trimmed.toLowerCase().replace(/\s+/g, ' ')
    if (seen.has(key))
      continue

    seen.add(key)
    distilled.push(trimmed.length > maxEntryLength ? `${trimmed.slice(0, maxEntryLength)} ...` : trimmed)
    if (distilled.length >= maxEntries)
      break
  }
  return distilled
}

async function readPackageScripts(projectRoot: string, forbiddenPathPatterns: string[]): Promise<Array<{ name: string, command: string }>> {
  let raw = ''
  try {
    raw = await readProjectFile({
      projectRoot,
      relativePath: 'package.json',
      forbiddenPathPatterns,
    })
  }
  catch (error) {
    if (isMissingFileError(error))
      return []
    throw error
  }
  const parsed = JSON.parse(raw) as { scripts?: Record<string, string> }
  return Object.entries(parsed.scripts ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, command]) => ({ name, command }))
}

/**
 * Builds a compact context pack for one runner invocation.
 *
 * Use when:
 * - Project manager, worker, and reviewer agents need shared local context
 * - Previous failures should be visible before another attempt starts
 *
 * Expects:
 * - `projectRoot` points at the active root, which may be an isolated worktree
 * - `source` is a lightweight snapshot from the project-management store
 *
 * Returns:
 * - Best-effort context; collection errors are stored as warnings, not thrown
 */
export async function buildProjectRunnerContextPack(params: {
  forbiddenPathPatterns: string[]
  project: Project
  projectRoot: string
  source?: ProjectRunnerContextSource
  workItem: WorkItem
}): Promise<ProjectRunnerContextPack> {
  const warnings: string[] = []
  let rootEntries: ProjectDirectoryEntry[] = []
  let symbols: ProjectSymbolEntry[] = []
  let packageScripts: Array<{ name: string, command: string }> = []
  let gitChangedFiles: string[] = []
  let recommendedTests: Array<{ command: string, reason: string }> = []

  try {
    rootEntries = (await listProjectDirectory({
      projectRoot: params.projectRoot,
      forbiddenPathPatterns: params.forbiddenPathPatterns,
    })).slice(0, 80)
  }
  catch (error) {
    warnings.push(`root entries unavailable: ${errorMessageFrom(error) ?? 'unknown error'}`)
  }

  try {
    packageScripts = await readPackageScripts(params.projectRoot, params.forbiddenPathPatterns)
  }
  catch (error) {
    warnings.push(`package scripts unavailable: ${errorMessageFrom(error) ?? 'unknown error'}`)
  }

  try {
    symbols = await indexProjectSymbols({
      projectRoot: params.projectRoot,
      forbiddenPathPatterns: params.forbiddenPathPatterns,
      maxSymbols: 80,
    })
  }
  catch (error) {
    warnings.push(`symbol index unavailable: ${errorMessageFrom(error) ?? 'unknown error'}`)
  }

  try {
    gitChangedFiles = params.project.gitEnabled ? await getGitChangedFiles(params.projectRoot) : []
  }
  catch (error) {
    warnings.push(`git changed files unavailable: ${errorMessageFrom(error) ?? 'unknown error'}`)
  }

  try {
    recommendedTests = (await recommendProjectTestCommands(params.projectRoot)).recommendations
  }
  catch (error) {
    warnings.push(`recommended tests unavailable: ${errorMessageFrom(error) ?? 'unknown error'}`)
  }

  const relatedWorkItems = (params.source?.workItems ?? [])
    .filter(item => item.projectId === params.project.id && item.id !== params.workItem.id)
    .sort((a, b) => a.position - b.position)
    .slice(0, 12)
    .map(item => ({
      identifier: item.identifier,
      status: item.status,
      title: item.title,
    }))
  const recentComments = (params.source?.comments ?? [])
    .filter(comment => comment.workItemId === params.workItem.id)
    .sort(sortByNewestComment)
    .slice(0, 12)
    .map(comment => ({
      actorType: comment.actorType,
      content: comment.content,
      kind: comment.kind,
    }))
  const recentRuns = (params.source?.runs ?? [])
    .filter(run => run.workItemId === params.workItem.id)
    .sort(sortByLatestRun)
    .slice(0, 6)
    .map(run => ({
      attempt: run.attempt,
      changedFiles: run.changedFiles,
      error: run.error,
      lifecycleStatus: run.lifecycleStatus,
      planSummary: run.planSummary,
      reviewerComment: run.reviewerComment,
      status: run.status,
      subtaskProgress: run.subtaskProgress,
      testSummary: run.testSummary,
      workerComment: run.workerComment,
    }))
  const failureMemory = distillFailureMemory([
    ...(params.source?.comments ?? [])
      .filter(comment => comment.workItemId === params.workItem.id)
      .filter(comment => comment.kind === 'review' || comment.kind === 'test' || comment.kind === 'status')
      .filter(comment => isFailureLikeText(comment.content))
      .sort(sortByNewestComment)
      .slice(0, 8)
      .map(formatCommentMemory),
    ...(params.source?.runs ?? [])
      .filter(run => run.workItemId === params.workItem.id)
      .sort(sortByLatestRun)
      .map(formatRunMemory)
      .filter((item): item is string => !!item)
      .slice(0, 8),
  ])

  return {
    rootEntries,
    symbols,
    packageScripts,
    recommendedTests,
    relatedWorkItems,
    recentComments,
    recentRuns,
    failureMemory,
    gitChangedFiles,
    warnings,
  }
}

function formatLines<T>(title: string, items: T[], format: (item: T) => string): string {
  if (items.length === 0)
    return ''

  return `${title}:\n${items.map(item => `- ${format(item)}`).join('\n')}`
}

/**
 * Formats runner context for model prompts.
 *
 * Use when:
 * - A shared context pack should be included in agent messages
 * - The prompt needs deterministic, compact sections instead of raw JSON
 *
 * Expects:
 * - The pack was produced by {@link buildProjectRunnerContextPack}
 *
 * Returns:
 * - Human-readable prompt text with empty sections omitted
 */
export function formatProjectRunnerContextPack(pack: ProjectRunnerContextPack): string {
  return [
    formatLines('Root files', pack.rootEntries, entry => `${entry.path} (${entry.type})`),
    formatLines('Symbols', pack.symbols, symbol => `${symbol.exported ? 'exported ' : ''}${symbol.name} ${symbol.kind} at ${symbol.path}:${symbol.line}`),
    formatLines('Package scripts', pack.packageScripts, script => `${script.name}: ${script.command}`),
    formatLines('Recommended validation', pack.recommendedTests, test => `${test.command} (${test.reason})`),
    formatLines('Related work items', pack.relatedWorkItems, item => `${item.identifier} [${item.status}] ${item.title}`),
    formatLines('Recent comments', pack.recentComments, comment => `${comment.actorType}/${comment.kind}: ${comment.content}`),
    formatLines('Recent runs', pack.recentRuns, run => [
      `status=${run.status}`,
      run.lifecycleStatus ? `phase=${run.lifecycleStatus}` : '',
      `attempt=${run.attempt}`,
      run.planSummary ? `plan=${run.planSummary}` : '',
      run.subtaskProgress?.length ? `subtasks=${run.subtaskProgress.map(item => `${item.status}:${item.title}`).join(', ')}` : '',
      run.changedFiles.length > 0 ? `files=${run.changedFiles.join(', ')}` : '',
      run.workerComment ? `worker=${run.workerComment}` : '',
      run.reviewerComment ? `reviewer=${run.reviewerComment}` : '',
      run.error ? `error=${run.error}` : '',
    ].filter(Boolean).join('; ')),
    formatLines('Failure memory', pack.failureMemory, item => item),
    formatLines('Current git changes', pack.gitChangedFiles, item => item),
    formatLines('Context warnings', pack.warnings, item => item),
  ].filter(Boolean).join('\n\n')
}
