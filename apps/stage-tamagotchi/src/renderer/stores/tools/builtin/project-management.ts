import type { Tool } from '@xsai/shared-chat'
import type { JsonSchema } from 'xsschema'

import type {
  CreateProjectWorkItemPayload,
  ProjectManagementSnapshot,
  RegisterProjectPayload,
  StartProjectWorkItemPayload,
  UpdateProjectWorkItemPayload,
} from '../../../../shared/eventa'

import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { createNextWorkItemIdentifier, WORK_ITEM_STATUSES } from '@proj-airi/stage-projects'
import { rawTool } from '@xsai/tool'

import {
  projectManagementCreateWorkItem,
  projectManagementDeleteWorkItem,
  projectManagementGetBoardUrl,
  projectManagementGetSnapshot,
  projectManagementOpenBoardExternal,
  projectManagementRegisterProject,
  projectManagementStartWorkItem,
  projectManagementUpdateWorkItem,
} from '../../../../shared/eventa'

type ProjectManagementActionInput
  = | {
    action: 'list_projects'
    rootPath?: string
    issuePrefix?: string
    projectId?: string
    identifier?: string
    title?: string
    goal?: string
    acceptanceCriteria?: string[] | string
    commitPrefix?: string
    allowDuplicateIdentifier?: boolean
    allowDirtyWorktree?: boolean
    workItemId?: string
    status?: UpdateProjectWorkItemPayload['patch']['status']
  }
  | {
    action: 'register_project'
    rootPath: string
    issuePrefix: string
    projectId?: string
    identifier?: string
    title?: string
    goal?: string
    acceptanceCriteria?: string[] | string
    commitPrefix?: string
    allowDuplicateIdentifier?: boolean
    allowDirtyWorktree?: boolean
    workItemId?: string
    status?: UpdateProjectWorkItemPayload['patch']['status']
  }
  | {
    action: 'list_work_items'
    projectId?: string
    rootPath?: string
    issuePrefix?: string
    identifier?: string
    title?: string
    goal?: string
    acceptanceCriteria?: string[] | string
    commitPrefix?: string
    allowDuplicateIdentifier?: boolean
    allowDirtyWorktree?: boolean
    workItemId?: string
    status?: UpdateProjectWorkItemPayload['patch']['status']
  }
  | {
    action: 'summarize_progress'
    projectId?: string | null
    rootPath?: string | null
    issuePrefix?: string | null
    identifier?: string | null
    title?: string | null
    goal?: string | null
    acceptanceCriteria?: string[] | string | null
    commitPrefix?: string | null
    allowDuplicateIdentifier?: boolean | null
    allowDirtyWorktree?: boolean | null
    workItemId?: string | null
    status?: UpdateProjectWorkItemPayload['patch']['status'] | null
  }
  | {
    action: 'create_work_item'
    projectId?: string | null
    identifier?: string | null
    title?: string | null
    goal?: string | null
    acceptanceCriteria?: string[] | string | null
    commitPrefix?: string | null
    allowDuplicateIdentifier?: boolean
    allowDirtyWorktree?: boolean
    rootPath?: string
    issuePrefix?: string
    workItemId?: string
    status?: UpdateProjectWorkItemPayload['patch']['status']
  }
  | {
    action: 'update_work_item'
    workItemId: string
    status?: UpdateProjectWorkItemPayload['patch']['status']
    title?: string
    goal?: string
    acceptanceCriteria?: string[] | string
    commitPrefix?: string | null
    projectId?: string
    rootPath?: string
    issuePrefix?: string
    identifier?: string
    allowDuplicateIdentifier?: boolean
    allowDirtyWorktree?: boolean
  }
  | {
    action: 'start_work_item'
    workItemId?: string
    identifier?: string
    projectId?: string
    rootPath?: string
    issuePrefix?: string
    title?: string
    goal?: string
    acceptanceCriteria?: string[] | string
    commitPrefix?: string
    allowDuplicateIdentifier?: boolean
    allowDirtyWorktree?: boolean
    status?: UpdateProjectWorkItemPayload['patch']['status']
  }
  | {
    action: 'open_board'
    projectId?: string
    rootPath?: string
    issuePrefix?: string
    identifier?: string
    title?: string
    goal?: string
    acceptanceCriteria?: string[] | string
    commitPrefix?: string
    allowDuplicateIdentifier?: boolean
    allowDirtyWorktree?: boolean
    workItemId?: string
    status?: UpdateProjectWorkItemPayload['patch']['status']
  }
  | {
    action: 'delete_work_item'
    workItemId: string
    projectId?: string
    rootPath?: string
    issuePrefix?: string
    identifier?: string
    title?: string
    goal?: string
    acceptanceCriteria?: string[] | string
    commitPrefix?: string
    allowDuplicateIdentifier?: boolean
    allowDirtyWorktree?: boolean
    status?: UpdateProjectWorkItemPayload['patch']['status']
  }

export type ProjectManagementInvokers = ReturnType<typeof createInvokers>

let cachedInvokers: ProjectManagementInvokers | undefined

function createInvokers() {
  const { context } = createContext(window.electron.ipcRenderer)

  return {
    getSnapshot: defineInvoke(context, projectManagementGetSnapshot),
    getBoardUrl: defineInvoke(context, projectManagementGetBoardUrl),
    openBoardExternal: defineInvoke(context, projectManagementOpenBoardExternal),
    registerProject: defineInvoke(context, projectManagementRegisterProject),
    createWorkItem: defineInvoke(context, projectManagementCreateWorkItem),
    deleteWorkItem: defineInvoke(context, projectManagementDeleteWorkItem),
    updateWorkItem: defineInvoke(context, projectManagementUpdateWorkItem),
    startWorkItem: defineInvoke(context, projectManagementStartWorkItem),
  }
}

function resolveInvokers(override?: ProjectManagementInvokers): ProjectManagementInvokers {
  if (override)
    return override
  if (!cachedInvokers)
    cachedInvokers = createInvokers()
  return cachedInvokers
}

const nullableStringSchema = {
  type: ['string', 'null'],
} satisfies JsonSchema

const projectManagementParams = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list_projects', 'register_project', 'list_work_items', 'summarize_progress', 'create_work_item', 'update_work_item', 'delete_work_item', 'start_work_item', 'open_board'],
      description: 'Choose one project-management action. Use summarize_progress for project progress, status, blocked, review, or specific work-item status questions.',
    },
    rootPath: {
      ...nullableStringSchema,
      description: 'Absolute local project folder path. Required for register_project.',
    },
    issuePrefix: {
      ...nullableStringSchema,
      description: 'User-entered issue key prefix such as AIRI. Required for register_project.',
    },
    projectId: {
      ...nullableStringSchema,
      description: 'Project id used to list or create work items.',
    },
    identifier: {
      ...nullableStringSchema,
      description: 'Work item identifier such as AIRI-12.',
    },
    title: nullableStringSchema,
    goal: nullableStringSchema,
    acceptanceCriteria: {
      type: ['array', 'string', 'null'],
      items: { type: 'string' },
      description: 'Completion criteria as a string list or newline-separated string.',
    },
    commitPrefix: {
      ...nullableStringSchema,
      description: 'Optional external commit prefix such as AC-781. Prepended to automatic commit messages.',
    },
    allowDuplicateIdentifier: {
      type: ['boolean', 'null'],
      description: 'Set true only after the user confirms a duplicate identifier.',
    },
    allowDirtyWorktree: {
      type: ['boolean', 'null'],
      description: 'Set true only after the user confirms AIRI can start while the original project folder has dirty files.',
    },
    workItemId: nullableStringSchema,
    status: {
      type: ['string', 'null'],
      enum: ['todo', 'in_progress', 'in_review', 'done', 'blocked', null],
    },
  },
  // NOTICE:
  // Only `action` is required; each action's required fields (e.g. rootPath +
  // issuePrefix for register_project) are validated at execution time. Forcing
  // all 13 fields required made weak models emit large, error-prone payloads
  // even for `list_projects`. The tool is created with strict:false so this
  // partial-required schema is accepted by strict providers.
  required: [
    'action',
  ],
  additionalProperties: false,
} satisfies JsonSchema

/**
 * Normalizes completion criteria received from the LLM tool call.
 *
 * Before:
 * - `"A\nB"`
 * - `["A", "B"]`
 *
 * After:
 * - `["A", "B"]`
 */
export function normalizeAcceptanceCriteria(input: string[] | string | null | undefined): string[] {
  if (Array.isArray(input))
    return input.map(item => item.trim()).filter(Boolean)
  return (input ?? '').split(/\r?\n/).map(item => item.trim()).filter(Boolean)
}

function summarizeSnapshot(snapshot: ProjectManagementSnapshot, projectId?: string | null) {
  const workItems = projectId
    ? snapshot.workItems.filter(item => item.projectId === projectId)
    : snapshot.workItems

  return JSON.stringify({
    projects: snapshot.projects.map(project => ({
      id: project.id,
      name: project.name,
      issuePrefix: project.issuePrefix,
      rootPath: project.rootPath,
      gitEnabled: project.gitEnabled,
    })),
    workItems: workItems.map(item => ({
      id: item.id,
      identifier: item.identifier,
      title: item.title,
      status: item.status,
    })),
  }, null, 2)
}

function summarizeWorkItems(snapshot: ProjectManagementSnapshot, input: {
  projectId?: string | null
  status?: UpdateProjectWorkItemPayload['patch']['status'] | null
}): string {
  const workItems = snapshot.workItems
    .filter(item => !input.projectId || item.projectId === input.projectId)
    .filter(item => !input.status || item.status === input.status)

  if (workItems.length === 0) {
    return input.status
      ? `${input.status} 상태 일감이 없어.`
      : '등록된 일감이 없어.'
  }

  return workItems
    .map(item => `- ${item.identifier}: ${item.title} (${item.status})`)
    .join('\n')
}

const statusLabels: Record<string, string> = {
  queued: '대기',
  todo: 'TODO',
  in_progress: '진행 중',
  in_review: '리뷰 중',
  done: '완료',
  blocked: '막힘',
}

const lifecycleLabels: Record<string, string> = {
  blocked: '막힘',
  completed: '완료됨',
  integrating: '통합 중',
  planning: '계획 중',
  queued: '대기 중',
  reviewing: '리뷰 중',
  validating: '검증 중',
  working: '작업 중',
}

const worktreeStateLabels: Record<string, string> = {
  active: 'worktree 활성',
  none: 'worktree 없음',
  preserved: 'worktree 보존',
  removed: 'worktree 정리됨',
}

function summarizeTextSnippet(text: string, limit = 180): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}

function summarizeCount(count: number, unit = '개') {
  return `${count}${unit}`
}

function getProgressPercent(doneCount: number, totalCount: number) {
  return totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0
}

function getLatestRun(snapshot: ProjectManagementSnapshot, workItemId: string) {
  return snapshot.runs
    .filter(run => run.workItemId === workItemId)
    .sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt))
    .at(0)
}

function getLatestComments(snapshot: ProjectManagementSnapshot, workItemId: string, limit: number) {
  return snapshot.comments
    .filter(comment => comment.workItemId === workItemId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
}

function formatRunSummary(snapshot: ProjectManagementSnapshot, workItemId: string): string | undefined {
  const run = getLatestRun(snapshot, workItemId)
  if (!run)
    return undefined

  const completedSubtasks = run.subtaskProgress?.filter(item => item.status === 'done').length ?? 0
  const totalSubtasks = run.subtaskProgress?.length ?? 0
  const details = [
    `${statusLabels[run.status] ?? run.status}`,
    run.lifecycleStatus ? `단계 ${lifecycleLabels[run.lifecycleStatus] ?? run.lifecycleStatus}` : '',
    `시도 ${run.attempt}`,
    run.planSummary ? `계획: ${summarizeTextSnippet(run.planSummary, 120)}` : '',
    totalSubtasks > 0 ? `서브태스크 ${completedSubtasks}/${totalSubtasks}` : '',
    run.changedFiles.length > 0 ? `변경 파일 ${run.changedFiles.length}개` : '',
    run.verificationCommands?.length ? `검증 명령 ${run.verificationCommands.length}개` : '',
    run.testSummary ? `테스트: ${summarizeTextSnippet(run.testSummary)}` : '',
    run.error ? `오류: ${summarizeTextSnippet(run.error)}` : '',
    run.commitHash ? `커밋 ${run.commitHash.slice(0, 8)}` : '',
    run.worktreeState && run.worktreeState !== 'none' ? worktreeStateLabels[run.worktreeState] ?? run.worktreeState : '',
  ].filter(Boolean)

  return details.join(', ')
}

function formatWorkItemProgressLine(snapshot: ProjectManagementSnapshot, item: ProjectManagementSnapshot['workItems'][number]): string {
  const runSummary = formatRunSummary(snapshot, item.id)
  return runSummary
    ? `- ${item.identifier}: ${item.title} (${statusLabels[item.status]}; ${runSummary})`
    : `- ${item.identifier}: ${item.title} (${statusLabels[item.status]})`
}

function formatFocusedWorkItemProgress(snapshot: ProjectManagementSnapshot, item: ProjectManagementSnapshot['workItems'][number]): string {
  const project = snapshot.projects.find(candidate => candidate.id === item.projectId)
  const latestComments = getLatestComments(snapshot, item.id, 3)
  const runSummary = formatRunSummary(snapshot, item.id)
  const lines = [
    `${item.identifier} 상태: ${statusLabels[item.status]}`,
    `- 프로젝트: ${project?.name ?? item.projectId}`,
    `- 제목: ${item.title}`,
    item.goal ? `- 목표: ${item.goal}` : '',
    item.acceptanceCriteria.length > 0 ? `- 완료 조건: ${item.acceptanceCriteria.join(' / ')}` : '',
    runSummary ? `- 최근 실행: ${runSummary}` : '',
    ...latestComments.map(comment => `- 최근 메모(${comment.actorType}/${comment.kind}): ${summarizeTextSnippet(comment.content, 220)}`),
  ].filter(Boolean)

  return lines.join('\n')
}

function formatStatusDistribution(workItems: ProjectManagementSnapshot['workItems']) {
  const counts = Object.fromEntries(WORK_ITEM_STATUSES.map(status => [
    status,
    workItems.filter(item => item.status === status).length,
  ])) as Record<NonNullable<UpdateProjectWorkItemPayload['patch']['status']>, number>

  return WORK_ITEM_STATUSES
    .map(status => `${statusLabels[status]} ${summarizeCount(counts[status])}`)
    .join(', ')
}

function summarizeProjectProgress(snapshot: ProjectManagementSnapshot, input: {
  identifier?: string | null
  issuePrefix?: string | null
  projectId?: string | null
  rootPath?: string | null
  status?: UpdateProjectWorkItemPayload['patch']['status'] | null
}): string {
  if (snapshot.projects.length === 0)
    return '등록된 프로젝트가 없어. 프로젝트를 먼저 등록하면 진행상황을 알려줄 수 있어.'

  const identifier = textOrUndefined(input.identifier)?.toUpperCase()
  if (identifier) {
    const item = snapshot.workItems.find(candidate => candidate.identifier === identifier)
    return item
      ? formatFocusedWorkItemProgress(snapshot, item)
      : `일감 ${identifier}을 찾지 못했어.`
  }

  const projectId = resolveSingleProjectId(snapshot, input)
  const projects = projectId
    ? snapshot.projects.filter(project => project.id === projectId)
    : snapshot.projects

  if (projects.length === 0)
    return '요청한 프로젝트를 찾지 못했어.'

  const sections = projects.map((project) => {
    const workItems = snapshot.workItems
      .filter(item => item.projectId === project.id)
      .sort((a, b) => a.position - b.position || a.identifier.localeCompare(b.identifier))
    if (workItems.length === 0)
      return `${project.name} (${project.issuePrefix}) 진행상황:\n- 등록된 일감이 없어.`

    const doneCount = workItems.filter(item => item.status === 'done').length
    const focusedItems = input.status
      ? workItems.filter(item => item.status === input.status)
      : [
          ...workItems.filter(item => item.status === 'blocked'),
          ...workItems.filter(item => item.status === 'in_progress'),
          ...workItems.filter(item => item.status === 'in_review'),
          ...workItems.filter(item => item.status === 'todo').slice(0, 3),
        ]
    const recentComments = snapshot.comments
      .filter(comment => workItems.some(item => item.id === comment.workItemId))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 2)

    return [
      `${project.name} (${project.issuePrefix}) 진행상황:`,
      `- 진행률: ${doneCount}/${workItems.length} 완료 (${getProgressPercent(doneCount, workItems.length)}%)`,
      `- 상태 분포: ${formatStatusDistribution(workItems)}`,
      input.status
        ? `- ${statusLabels[input.status]} 일감: ${focusedItems.length > 0 ? '' : '없어.'}`
        : '- 우선 확인할 일감:',
      focusedItems.length > 0
        ? focusedItems.slice(0, 6).map(item => formatWorkItemProgressLine(snapshot, item)).join('\n')
        : '',
      recentComments.length > 0
        ? [
            '- 최근 메모:',
            ...recentComments.map(comment => `  - ${comment.actorType}/${comment.kind}: ${summarizeTextSnippet(comment.content, 220)}`),
          ].join('\n')
        : '',
    ].filter(Boolean).join('\n')
  })

  return sections.join('\n\n')
}

function textOrUndefined(input: string | null | undefined): string | undefined {
  const value = input?.trim()
  return value || undefined
}

function resolveSingleProjectId(snapshot: ProjectManagementSnapshot, input: {
  issuePrefix?: string | null
  projectId?: string | null
  rootPath?: string | null
}): string | undefined {
  const projectId = textOrUndefined(input.projectId)
  if (projectId)
    return projectId

  const issuePrefix = textOrUndefined(input.issuePrefix)?.toUpperCase()
  if (issuePrefix) {
    const project = snapshot.projects.find(item => item.issuePrefix === issuePrefix)
    if (project)
      return project.id
  }

  const rootPath = textOrUndefined(input.rootPath)
  if (rootPath) {
    const project = snapshot.projects.find(item => item.rootPath === rootPath)
    if (project)
      return project.id
  }

  return snapshot.projects.length === 1 ? snapshot.projects[0]?.id : undefined
}

function formatMissingWorkItemCreationFields(missingFields: string[]): string {
  return `일감을 등록하려면 ${missingFields.join(', ')} 정보가 더 필요해. 알려주면 TODO 상태로 등록할게.`
}

/**
 * Executes one AIRI project-management tool call.
 *
 * Use when:
 * - AIRI needs to register projects, create work items, or update card state from chat
 *
 * Expects:
 * - Goal and acceptance criteria are already confirmed with the user before creating a work item
 *
 * Returns:
 * - A compact human-readable result for AIRI to summarize in chat
 */
export async function executeProjectManagementAction(
  input: ProjectManagementActionInput,
  deps?: { invokers?: ProjectManagementInvokers, boardUrl?: string },
) {
  const invokers = resolveInvokers(deps?.invokers)

  switch (input.action) {
    case 'list_projects': {
      return summarizeSnapshot(await invokers.getSnapshot())
    }
    case 'register_project': {
      const payload: RegisterProjectPayload = {
        rootPath: input.rootPath,
        issuePrefix: input.issuePrefix,
      }
      const project = await invokers.registerProject(payload)
      return `Registered project ${project.name} (${project.issuePrefix}) at ${project.rootPath}.`
    }
    case 'list_work_items': {
      return summarizeWorkItems(await invokers.getSnapshot(), {
        projectId: input.projectId,
        status: input.status,
      })
    }
    case 'summarize_progress': {
      return summarizeProjectProgress(await invokers.getSnapshot(), {
        identifier: input.identifier,
        issuePrefix: input.issuePrefix,
        projectId: input.projectId,
        rootPath: input.rootPath,
        status: input.status,
      })
    }
    case 'create_work_item': {
      const snapshot = await invokers.getSnapshot()
      const projectId = resolveSingleProjectId(snapshot, input)
      const project = projectId ? snapshot.projects.find(item => item.id === projectId) : undefined
      const projectWorkItems = project
        ? snapshot.workItems.filter(item => item.projectId === project.id)
        : []
      const identifier = textOrUndefined(input.identifier) ?? (project
        ? createNextWorkItemIdentifier({
            issuePrefix: project.issuePrefix,
            identifiers: projectWorkItems.map(item => item.identifier),
          })
        : undefined)
      const title = textOrUndefined(input.title)
      const goal = textOrUndefined(input.goal)
      const acceptanceCriteria = normalizeAcceptanceCriteria(input.acceptanceCriteria)
      const missingFields: string[] = []

      if (!project)
        missingFields.push(snapshot.projects.length === 0 ? '등록된 프로젝트' : '프로젝트')
      if (!title)
        missingFields.push('제목')
      if (!goal)
        missingFields.push('목표')
      if (acceptanceCriteria.length === 0)
        missingFields.push('완료 조건')

      if (missingFields.length > 0)
        return formatMissingWorkItemCreationFields(missingFields)

      const payload: CreateProjectWorkItemPayload = {
        projectId: project!.id,
        identifier: identifier!,
        title: title!,
        goal: goal!,
        acceptanceCriteria,
        commitPrefix: textOrUndefined(input.commitPrefix),
        allowDuplicateIdentifier: input.allowDuplicateIdentifier ?? false,
      }
      const result = await invokers.createWorkItem(payload)
      if (result.duplicate) {
        return result.existing
          ? `Duplicate identifier ${input.identifier}. Existing work item: ${result.existing.title} (${result.existing.id}). Ask the user before retrying with allowDuplicateIdentifier=true.`
          : `Duplicate identifier ${input.identifier}. Ask the user before retrying with allowDuplicateIdentifier=true.`
      }
      return `Created work item ${result.workItem?.identifier}: ${result.workItem?.title}.`
    }
    case 'update_work_item': {
      const patch: UpdateProjectWorkItemPayload['patch'] = {}
      if (input.status)
        patch.status = input.status
      if (input.title)
        patch.title = input.title
      if (input.goal)
        patch.goal = input.goal
      if (input.acceptanceCriteria)
        patch.acceptanceCriteria = normalizeAcceptanceCriteria(input.acceptanceCriteria)
      if (input.commitPrefix !== undefined)
        patch.commitPrefix = textOrUndefined(input.commitPrefix) ?? null

      const workItem = await invokers.updateWorkItem({
        id: input.workItemId,
        patch,
      })
      return `Updated work item ${workItem.identifier}: ${workItem.status}.`
    }
    case 'delete_work_item': {
      await invokers.deleteWorkItem({ id: input.workItemId })
      return `Deleted work item ${input.workItemId}.`
    }
    case 'start_work_item': {
      const payload: StartProjectWorkItemPayload = {
        workItemId: input.workItemId ?? undefined,
        identifier: input.identifier ?? undefined,
        allowDirtyWorktree: input.allowDirtyWorktree ?? false,
      }
      const result = await invokers.startWorkItem(payload)
      return result.message
    }
    case 'open_board': {
      if (deps?.boardUrl) {
        globalThis.window?.open?.(deps.boardUrl, '_blank', 'noopener,noreferrer')
        return `Opened project board: ${deps.boardUrl}`
      }

      const result = await invokers.openBoardExternal()
      if (!result.opened || !result.url)
        return 'Project board server is not ready yet.'
      return 'Opened project board in external browser.'
    }
    default: {
      const unsupported: never = input
      return `Unsupported project-management action: ${JSON.stringify(unsupported)}`
    }
  }
}

const tools: Tool[] = [
  rawTool({
    name: 'stage_project_management',
    // strict:false so the partial-required schema (only `action`) is accepted;
    // per-action fields are validated in executeProjectManagementAction.
    strict: false,
    description: 'Manage AIRI local project work: register projects, list projects, create/list/update/delete work items, and open the local board.',
    execute: params => executeProjectManagementAction(params as ProjectManagementActionInput),
    parameters: projectManagementParams,
  }),
]

export const projectManagementTools = async () => tools
