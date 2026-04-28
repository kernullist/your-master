import type { Project, ProjectAgentSettings, WorkItem, WorkItemRunRecord } from '@proj-airi/stage-projects'

import type { AgentChatMessage, AgentRuntimeFetch } from './agent-runtime'
import type { ReviewerAgentResult, WorkerAgentResult } from './review-loop'

import { errorMessageFrom } from '@moeru/std'

import { callAgentText } from './agent-runtime'
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
import { runProjectReviewLoop } from './review-loop'
import { runProjectTestCommand } from './tests'
import {
  listProjectDirectory,
  readProjectFile,
  replaceInProjectFile,
  runProjectShellCommand,
  searchProjectFiles,
} from './tools'

type WorkerAction
  = | { action: 'list', path?: string }
    | { action: 'read', path: string }
    | { action: 'search', query: string, path?: string }
    | { action: 'replace', path: string, search: string, replace: string, replaceAll?: boolean }
    | { action: 'shell', command: string }
    | { action: 'final', comment: string }

interface ReviewerDecision {
  passed: boolean
  comment: string
}

interface ProjectManagerBrief {
  summary: string
  implementationPlan: string[]
  riskNotes: string[]
  reviewFocus: string[]
  suggestedTests: string[]
}

interface ProjectRunnerStore {
  addComment: (payload: { actorType: 'worker' | 'reviewer' | 'system', content: string, kind: 'worker' | 'review' | 'status' | 'diff' | 'test' | 'commit', workItemId: string }) => unknown
  updateWorkItem: (payload: { id: string, patch: { status: WorkItem['status'] } }) => WorkItem
  upsertRunRecord: (run: WorkItemRunRecord) => WorkItemRunRecord
}

/**
 * Extracts a JSON object from a model response.
 *
 * Before:
 * - "```json\n{\"action\":\"final\",\"comment\":\"done\"}\n```"
 *
 * After:
 * - `{ action: "final", comment: "done" }`
 */
export function parseAgentJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  const source = trimmed.startsWith('```')
    ? trimmed
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/, '')
        .trim()
    : trimmed
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
      }
    case 'replace':
      return {
        action,
        path: asString(parsed.path, 'path'),
        search: asString(parsed.search, 'search'),
        replace: asString(parsed.replace, 'replace'),
        replaceAll: parsed.replaceAll === true,
      }
    case 'shell':
      return { action, command: asString(parsed.command, 'command') }
    case 'final':
      return { action, comment: asString(parsed.comment, 'comment') }
    default:
      throw new Error(`Unsupported worker action: ${action}`)
  }
}

function parseReviewerDecision(text: string): ReviewerDecision {
  const parsed = parseAgentJsonObject(text)
  return {
    passed: parsed.passed === true,
    comment: asString(parsed.comment, 'comment'),
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
    implementationPlan: asStringArray(parsed.implementationPlan),
    riskNotes: asStringArray(parsed.riskNotes),
    reviewFocus: asStringArray(parsed.reviewFocus),
    suggestedTests: asStringArray(parsed.suggestedTests),
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
    formatBriefList('Implementation plan', brief.implementationPlan),
    formatBriefList('Risk notes', brief.riskNotes),
    formatBriefList('Review focus', brief.reviewFocus),
    formatBriefList('Suggested tests', brief.suggestedTests),
  ].filter(Boolean).join('\n\n')
}

function createWorkerSystemPrompt(): string {
  return [
    'You are AIRI Worker, a coding agent controlled through JSON actions.',
    'Return exactly one JSON object and no prose.',
    'Available actions:',
    '{"action":"list","path":"."}',
    '{"action":"read","path":"relative/file.ts"}',
    '{"action":"search","query":"text","path":"optional/path"}',
    '{"action":"replace","path":"relative/file.ts","search":"exact text","replace":"new text","replaceAll":false}',
    '{"action":"shell","command":"allowed command"}',
    '{"action":"final","comment":"short summary of completed work"}',
    'Use read/search before replace when needed. Finish with final only after edits are done.',
  ].join('\n')
}

function createWorkerTaskMessage(params: {
  attempt: number
  project: Project
  workItem: WorkItem
  managerBrief?: ProjectManagerBrief
  previousDiffSummary?: string
  previousReviewerComment?: string
}): AgentChatMessage {
  return {
    role: 'user',
    content: [
      `Project: ${params.project.name}`,
      `Work item: ${params.workItem.identifier} ${params.workItem.title}`,
      `Goal: ${params.workItem.goal}`,
      `Acceptance criteria:\n${params.workItem.acceptanceCriteria.map(item => `- ${item}`).join('\n')}`,
      params.managerBrief ? `Project manager brief:\n${formatProjectManagerBrief(params.managerBrief)}` : '',
      `Attempt: ${params.attempt + 1}`,
      params.previousReviewerComment ? `Previous reviewer feedback:\n${params.previousReviewerComment}` : '',
      params.previousDiffSummary ? `Previous diff summary:\n${params.previousDiffSummary}` : '',
    ].filter(Boolean).join('\n\n'),
  }
}

async function runWorkerWithTools(params: {
  fetcher?: AgentRuntimeFetch
  project: Project
  projectRoot: string
  settings: ProjectAgentSettings
  workItem: WorkItem
  managerBrief?: ProjectManagerBrief
  attempt: number
  previousDiffSummary?: string
  previousReviewerComment?: string
}): Promise<WorkerAgentResult> {
  const changedFiles = new Set<string>()
  const messages: AgentChatMessage[] = [
    { role: 'system', content: createWorkerSystemPrompt() },
    createWorkerTaskMessage({
      ...params,
      managerBrief: params.managerBrief,
    }),
  ]

  for (let step = 0; step < 30; step += 1) {
    const response = await callAgentText({
      config: params.settings.worker,
      messages,
      fetcher: params.fetcher,
      projectRoot: params.projectRoot,
    })
    const action = parseWorkerAction(response)
    messages.push({ role: 'assistant', content: response })

    if (action.action === 'final') {
      if (params.project.gitEnabled) {
        for (const file of await getGitChangedFiles(params.projectRoot)) {
          changedFiles.add(file)
        }
      }
      const diffSummary = params.project.gitEnabled
        ? await getAgentDiffSummary(params.projectRoot, [...changedFiles])
        : [...changedFiles].join('\n')
      const testResult = await runProjectTestCommand({
        projectRoot: params.projectRoot,
        settings: params.settings,
        configuredCommand: params.project.testCommand,
      })
      return {
        changedFiles: [...changedFiles],
        comment: action.comment,
        diffSummary,
        testSummary: testResult.summary,
      }
    }

    const toolResult = await executeWorkerAction({
      action,
      changedFiles,
      projectRoot: params.projectRoot,
      settings: params.settings,
    })
    messages.push({
      role: 'user',
      content: `Tool result:\n${truncateToolResult(toolResult)}`,
    })
  }

  throw new Error('Worker agent did not finish within 30 tool steps.')
}

async function executeWorkerAction(params: {
  action: Exclude<WorkerAction, { action: 'final' }>
  changedFiles: Set<string>
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
      params.changedFiles.add(params.action.path)
      return result
    }
    case 'shell':
      return await runProjectShellCommand({
        projectRoot: params.projectRoot,
        command: params.action.command,
        settings: params.settings,
      })
  }
}

async function runReviewerAgent(params: {
  fetcher?: AgentRuntimeFetch
  managerBrief?: ProjectManagerBrief
  project: Project
  projectRoot: string
  settings: ProjectAgentSettings
  workItem: WorkItem
  workerResult: WorkerAgentResult
}): Promise<ReviewerAgentResult> {
  const response = await callAgentText({
    config: params.settings.reviewer,
    messages: [{
      role: 'user',
      content: [
        'Return exactly JSON: {"passed":true|false,"comment":"short review result"}',
        `Project: ${params.project.name}`,
        `Work item: ${params.workItem.identifier} ${params.workItem.title}`,
        `Goal: ${params.workItem.goal}`,
        `Acceptance criteria:\n${params.workItem.acceptanceCriteria.map(item => `- ${item}`).join('\n')}`,
        params.managerBrief ? `Project manager brief:\n${formatProjectManagerBrief(params.managerBrief)}` : '',
        `Worker comment:\n${params.workerResult.comment}`,
        `Diff summary:\n${params.workerResult.diffSummary}`,
        params.workerResult.testSummary ? `Test summary:\n${params.workerResult.testSummary}` : '',
      ].filter(Boolean).join('\n\n'),
    }],
    fetcher: params.fetcher,
    projectRoot: params.projectRoot,
  })
  return parseReviewerDecision(response)
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
  fetcher?: AgentRuntimeFetch
  project: Project
  projectRoot: string
  settings: ProjectAgentSettings
  workItem: WorkItem
}): Promise<ProjectManagerBrief | undefined> {
  if (!params.settings.projectManager.model.trim())
    return undefined

  const response = await callAgentText({
    config: params.settings.projectManager,
    messages: [{
      role: 'user',
      content: [
        'Return exactly JSON with this shape:',
        '{"summary":"short execution summary","implementationPlan":["step"],"riskNotes":["risk"],"reviewFocus":["focus"],"suggestedTests":["test command or check"]}',
        `Project: ${params.project.name}`,
        `Work item: ${params.workItem.identifier} ${params.workItem.title}`,
        `Goal: ${params.workItem.goal}`,
        `Acceptance criteria:\n${params.workItem.acceptanceCriteria.map(item => `- ${item}`).join('\n')}`,
        'Do not edit files. Prepare the brief for a coding worker and strict reviewer.',
      ].join('\n\n'),
    }],
    fetcher: params.fetcher,
    projectRoot: params.projectRoot,
  })

  return parseProjectManagerBrief(response)
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
  let managerBrief: ProjectManagerBrief | undefined
  let worktree: { branchName: string, path: string } | undefined
  let shouldRemoveWorktree = true
  const startedAt = params.now()

  const upsertRun = (patch: Partial<WorkItemRunRecord>) => {
    params.store.upsertRunRecord({
      id: runId,
      workItemId: params.workItem.id,
      status: patch.status ?? 'queued',
      attempt: patch.attempt ?? 0,
      changedFiles: patch.changedFiles ?? [],
      worktreePath: patch.worktreePath ?? worktree?.path,
      branchName: patch.branchName ?? worktree?.branchName,
      diffSummary: patch.diffSummary,
      workerComment: patch.workerComment,
      reviewerComment: patch.reviewerComment,
      testCommand: patch.testCommand,
      testSummary: patch.testSummary,
      commitHash: patch.commitHash,
      commitMessage: patch.commitMessage,
      error: patch.error,
      startedAt,
      finishedAt: patch.finishedAt,
    })
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
      params.store.addComment({
        workItemId: params.workItem.id,
        actorType: 'system',
        kind: 'status',
        content: `일감 worktree를 만들었어: ${worktree.path} (${worktree.branchName})`,
      })
    }

    upsertRun({
      status: 'in_progress',
      worktreePath: worktree?.path,
      branchName: worktree?.branchName,
    })

    try {
      managerBrief = await runProjectManagerAgent({
        fetcher: params.fetcher,
        project: params.project,
        projectRoot: activeProjectRoot,
        settings: params.settings,
        workItem: params.workItem,
      })
      if (managerBrief) {
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
        fetcher: params.fetcher,
        project: params.project,
        projectRoot: activeProjectRoot,
        settings: params.settings,
        workItem: params.workItem,
        managerBrief,
        attempt: input.attempt,
        previousReviewerComment: input.previousReviewerComment,
        previousDiffSummary: input.previousDiffSummary,
      }),
      runReviewer: async input => await runReviewerAgent({
        fetcher: params.fetcher,
        project: params.project,
        projectRoot: activeProjectRoot,
        settings: params.settings,
        workItem: params.workItem,
        managerBrief,
        workerResult: input.workerResult,
      }),
      updateStatus: async (status) => {
        params.store.updateWorkItem({
          id: params.workItem.id,
          patch: { status },
        })
        upsertRun({
          status: status === 'in_progress' || status === 'in_review' || status === 'done' || status === 'blocked'
            ? status
            : 'in_progress',
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
          await removeAgentWorktree(params.project.rootPath, worktree.path)
          worktree = undefined
          return
        }
        if (params.project.gitEnabled)
          await revertAgentChangedFiles(activeProjectRoot, changedFiles)
      },
    })

    let commitHash: string | undefined
    let commitMessage: string | undefined
    if (reviewResult.passed && params.project.gitEnabled && !params.settings.autoCommit && worktree) {
      shouldRemoveWorktree = false
      params.store.addComment({
        workItemId: params.workItem.id,
        actorType: 'system',
        kind: 'commit',
        content: `자동 커밋이 꺼져 있어서 변경사항을 ${worktree.path} worktree에 보존했어.`,
      })
    }

    if (reviewResult.passed && params.project.gitEnabled && params.settings.autoCommit) {
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
            ? `원본 프로젝트에 에이전트 커밋을 반영했어${integration.hash ? `: ${integration.hash}` : '.'}`
            : integration.conflict
              ? `원본 프로젝트 반영 중 충돌이 발생했어. ${worktree.branchName} 브랜치를 보존했으니 충돌을 수동으로 확인해줘.\n${integration.error ?? ''}`.trim()
              : `원본 프로젝트에 자동 반영하지 않았어. ${worktree.branchName} 브랜치를 보존했어.\n${integration.error ?? ''}`.trim(),
        })
      }
    }

    upsertRun({
      status: reviewResult.passed ? 'done' : 'blocked',
      attempt: reviewResult.attempts,
      changedFiles: reviewResult.changedFiles,
      reviewerComment: reviewResult.reviewerComment,
      commitHash,
      commitMessage,
      finishedAt: params.now(),
    })
  }
  catch (error) {
    const message = errorMessageFrom(error) ?? 'Project work item runner failed.'
    params.store.addComment({
      workItemId: params.workItem.id,
      actorType: 'system',
      kind: 'status',
      content: `작업 실행 실패: ${message}`,
    })
    params.store.updateWorkItem({
      id: params.workItem.id,
      patch: { status: 'blocked' },
    })
    upsertRun({
      status: 'blocked',
      error: message,
      finishedAt: params.now(),
    })

    if (worktree) {
      await removeAgentWorktree(params.project.rootPath, worktree.path).catch(() => {})
    }
  }
  finally {
    if (worktree && params.project.gitEnabled && shouldRemoveWorktree) {
      await removeAgentWorktree(params.project.rootPath, worktree.path).catch(() => {})
    }
  }
}
