import type {
  CreateWorkItemInput,
  Project,
  ProjectAgentSettings,
  UpdateWorkItemInput,
  WorkItem,
  WorkItemComment,
  WorkItemRunRecord,
} from '@proj-airi/stage-projects'

import { defineEventa, defineInvokeEventa } from '@moeru/eventa'

/**
 * Snapshot of local project-management data served from Electron main.
 */
export interface ProjectManagementSnapshot {
  /** Registered local projects. The MVP runner processes one active project at a time. */
  projects: Project[]
  /** Work items across registered projects. */
  workItems: WorkItem[]
  /** Compact comments, status notes, review notes, and diff summaries. */
  comments: WorkItemComment[]
  /** Worker/reviewer run summaries. */
  runs: WorkItemRunRecord[]
  /** Global AIRI/worker/reviewer settings. */
  settings: ProjectAgentSettings
}

/**
 * Payload used to register a local project folder.
 */
export interface RegisterProjectPayload {
  /** Absolute local project folder path. */
  rootPath: string
  /** Issue key prefix entered by the user, for example AIRI. */
  issuePrefix: string
  /** Optional display name. Defaults to the folder name. */
  name?: string
  /** Optional git capability override. Defaults to detecting a `.git` directory. */
  gitEnabled?: boolean
}

/**
 * Payload used to create a work item from AIRI chat.
 */
export interface CreateProjectWorkItemPayload extends CreateWorkItemInput {
  /** Allows duplicate identifiers after explicit user confirmation. */
  allowDuplicateIdentifier?: boolean
}

/**
 * Result returned when AIRI asks to create a work item.
 */
export interface CreateProjectWorkItemResult {
  /** Created work item when no duplicate conflict blocks creation. */
  workItem?: WorkItem
  /** True when another work item already uses the identifier. */
  duplicate: boolean
  /** Existing conflicting work item when duplicate confirmation is required. */
  existing?: WorkItem
}

/**
 * Payload used to update an existing work item.
 */
export interface UpdateProjectWorkItemPayload {
  /** Stable work item id. */
  id: string
  /** Partial update body. */
  patch: UpdateWorkItemInput
}

/**
 * Payload used to append a compact work item comment.
 */
export interface AddProjectWorkItemCommentPayload {
  /** Stable work item id. */
  workItemId: string
  /** Comment author category. */
  actorType: WorkItemComment['actorType']
  /** Comment kind used by board details and AIRI status messages. */
  kind: WorkItemComment['kind']
  /** Short comment body. */
  content: string
}

/**
 * Payload used to append or update a worker/reviewer run summary.
 */
export interface UpsertProjectRunRecordPayload {
  /** Execution record to persist. */
  run: WorkItemRunRecord
}

/**
 * Payload used when AIRI starts one TODO work item from chat or board actions.
 */
export interface StartProjectWorkItemPayload {
  /** Stable work item id. Prefer this when the caller already has a snapshot. */
  workItemId?: string
  /** User-facing work item identifier such as `AIRI-12`. */
  identifier?: string
  /** True after the user confirms AIRI can start despite dirty files in the original project folder. */
  allowDirtyWorktree?: boolean
}

/**
 * Result returned after AIRI tries to start one work item.
 */
export interface StartProjectWorkItemResult {
  /** True when AIRI changed the work item to `in_progress`. */
  started: boolean
  /** Work item that was inspected or started. */
  workItem?: WorkItem
  /** Human-readable result for AIRI chat. */
  message: string
  /** Missing fields AIRI must ask the user to fill before starting. */
  missingFields?: Array<'goal' | 'acceptanceCriteria'>
  /** Dirty git status lines that need user confirmation before editing. */
  dirtyFiles?: string[]
}

export const projectManagementGetSnapshot = defineInvokeEventa<ProjectManagementSnapshot>('eventa:invoke:project-management:get-snapshot')
export const projectManagementRegisterProject = defineInvokeEventa<Project, RegisterProjectPayload>('eventa:invoke:project-management:register-project')
export const projectManagementDeleteProject = defineInvokeEventa<void, { id: string }>('eventa:invoke:project-management:delete-project')
export const projectManagementCreateWorkItem = defineInvokeEventa<CreateProjectWorkItemResult, CreateProjectWorkItemPayload>('eventa:invoke:project-management:create-work-item')
export const projectManagementUpdateWorkItem = defineInvokeEventa<WorkItem, UpdateProjectWorkItemPayload>('eventa:invoke:project-management:update-work-item')
export const projectManagementAddComment = defineInvokeEventa<WorkItemComment, AddProjectWorkItemCommentPayload>('eventa:invoke:project-management:add-comment')
export const projectManagementUpsertRunRecord = defineInvokeEventa<WorkItemRunRecord, UpsertProjectRunRecordPayload>('eventa:invoke:project-management:upsert-run-record')
export const projectManagementUpdateSettings = defineInvokeEventa<ProjectAgentSettings, Partial<ProjectAgentSettings>>('eventa:invoke:project-management:update-settings')
export const projectManagementStartWorkItem = defineInvokeEventa<StartProjectWorkItemResult, StartProjectWorkItemPayload>('eventa:invoke:project-management:start-work-item')
export const projectManagementGetBoardUrl = defineInvokeEventa<{ url?: string }>('eventa:invoke:project-management:get-board-url')
export const projectManagementOpenBoardExternal = defineInvokeEventa<{ opened: boolean, url?: string }>('eventa:invoke:project-management:open-board-external')
export const projectManagementSnapshotChanged = defineEventa<ProjectManagementSnapshot>('eventa:event:project-management:snapshot-changed')
export const projectManagementWorkItemStatusChanged = defineEventa<{ workItem: WorkItem, previousStatus: WorkItem['status'] }>('eventa:event:project-management:work-item-status-changed')
