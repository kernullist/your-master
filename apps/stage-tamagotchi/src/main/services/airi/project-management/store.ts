import type {
  Project,
  ProjectAgentSettings,
  WorkItem,
  WorkItemComment,
  WorkItemRunRecord,
} from '@proj-airi/stage-projects'

import type {
  AddProjectWorkItemCommentPayload,
  CreateProjectWorkItemPayload,
  CreateProjectWorkItemResult,
  ProjectManagementSnapshot,
  RegisterProjectPayload,
  UpdateProjectWorkItemPayload,
} from '../../../../shared/eventa/project-management'

import { basename, normalize } from 'node:path'

import {
  defaultProjectAgentSettings,
  hasDuplicateIdentifier,
  normalizeIssuePrefix,
  normalizeWorkItemIdentifier,
} from '@proj-airi/stage-projects'

/**
 * Local project-management persistence shape.
 */
export interface ProjectManagementState extends ProjectManagementSnapshot {
  /** Schema version for future local migrations. */
  version: 1
}

/**
 * Hooks used to keep the store deterministic in tests and connected in Electron main.
 */
export interface ProjectManagementStoreOptions {
  /** Generates stable ids for projects, work items, comments, and runs. */
  generateId: () => string
  /** Returns epoch milliseconds. */
  now: () => number
  /** Persists a full state snapshot after mutations. */
  save: (state: ProjectManagementState) => void
  /** Notifies renderer windows or board servers after mutations. */
  notify?: (snapshot: ProjectManagementSnapshot) => void
  /** Notifies AIRI chat bridges when a work item status changes. */
  notifyStatusChange?: (workItem: WorkItem, previousStatus: WorkItem['status']) => void
}

type ProjectManagementSnapshotListener = (snapshot: ProjectManagementSnapshot) => void

/**
 * Creates the default persisted state for local project management.
 *
 * Use when:
 * - Electron persistence has no saved project-management file yet
 * - Tests need a minimal valid state
 *
 * Expects:
 * - Callers clone or treat the returned state as owned by the store
 *
 * Returns:
 * - A valid versioned state with empty project/work item data
 */
export function createDefaultProjectManagementState(): ProjectManagementState {
  return {
    version: 1,
    projects: [],
    workItems: [],
    comments: [],
    runs: [],
    settings: defaultProjectAgentSettings,
  }
}

function cloneState(state: ProjectManagementState): ProjectManagementState {
  return structuredClone(state)
}

function toSnapshot(state: ProjectManagementState): ProjectManagementSnapshot {
  return {
    projects: [...state.projects],
    workItems: [...state.workItems],
    comments: [...state.comments],
    runs: [...state.runs],
    settings: state.settings,
  }
}

/**
 * Normalizes project setting string lists while preserving user order.
 *
 * Before:
 * - `["rm", "del", "rm", " del "]`
 *
 * After:
 * - `["rm", "del"]`
 */
function normalizeUniqueStringList(items: string[] | undefined, fallback: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const item of items ?? fallback) {
    const normalized = item.trim()
    if (!normalized || seen.has(normalized))
      continue

    seen.add(normalized)
    result.push(normalized)
  }

  return result
}

/**
 * Merges project agent settings without concatenating arrays.
 *
 * Use when:
 * - The settings screen saves a full settings snapshot
 * - Chat tools patch only one or two top-level settings fields
 *
 * Expects:
 * - Nested agent model configs should keep previous fields when a patch omits them
 *
 * Returns:
 * - Settings with list fields replaced and de-duplicated
 */
export function mergeProjectAgentSettings(
  current: ProjectAgentSettings,
  patch: Partial<ProjectAgentSettings>,
): ProjectAgentSettings {
  return {
    ...current,
    ...patch,
    projectManager: {
      ...current.projectManager,
      ...patch.projectManager,
    },
    worker: {
      ...current.worker,
      ...patch.worker,
    },
    reviewer: {
      ...current.reviewer,
      ...patch.reviewer,
    },
    shellDenylist: normalizeUniqueStringList(patch.shellDenylist, current.shellDenylist),
    shellAllowlist: normalizeUniqueStringList(patch.shellAllowlist, current.shellAllowlist),
    forbiddenPathPatterns: normalizeUniqueStringList(patch.forbiddenPathPatterns, current.forbiddenPathPatterns),
  }
}

/**
 * Creates the mutable local project-management store used by Eventa handlers.
 *
 * Use when:
 * - Electron main needs CRUD operations over the local JSON persistence state
 * - Tests need deterministic project/work item behavior without Electron
 *
 * Expects:
 * - `initialState` has already been validated by Valibot or test setup
 *
 * Returns:
 * - Store methods that persist and notify after every mutation
 *
 * Call stack:
 *
 * setupProjectManagementService (./index)
 *   -> {@link createProjectManagementStore}
 *     -> Eventa invoke handlers
 */
export function createProjectManagementStore(
  initialState: ProjectManagementState,
  options: ProjectManagementStoreOptions,
) {
  const state = cloneState(initialState)
  const snapshotListeners = new Set<ProjectManagementSnapshotListener>()

  const commit = () => {
    const nextState = cloneState(state)
    const snapshot = toSnapshot(nextState)
    options.save(nextState)
    options.notify?.(snapshot)
    for (const listener of snapshotListeners) {
      listener(snapshot)
    }
  }

  const requireProject = (id: string): Project => {
    const project = state.projects.find(item => item.id === id)
    if (!project)
      throw new Error(`Project not found: ${id}`)
    return project
  }

  const requireWorkItem = (id: string): WorkItem => {
    const workItem = state.workItems.find(item => item.id === id)
    if (!workItem)
      throw new Error(`Work item not found: ${id}`)
    return workItem
  }

  return {
    /**
     * Returns a copy of the current state snapshot.
     */
    getSnapshot(): ProjectManagementSnapshot {
      return toSnapshot(cloneState(state))
    },

    /**
     * Subscribes to committed snapshot changes.
     */
    subscribeSnapshot(listener: ProjectManagementSnapshotListener): () => void {
      snapshotListeners.add(listener)
      return () => {
        snapshotListeners.delete(listener)
      }
    },

    /**
     * Registers a local project folder.
     */
    registerProject(payload: RegisterProjectPayload): Project {
      const now = options.now()
      const normalizedRootPath = normalize(payload.rootPath)
      const project: Project = {
        id: options.generateId(),
        name: payload.name?.trim() || basename(normalizedRootPath),
        issuePrefix: normalizeIssuePrefix(payload.issuePrefix),
        rootPath: normalizedRootPath,
        gitEnabled: payload.gitEnabled ?? false,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      }
      state.projects.push(project)
      commit()
      return project
    },

    /**
     * Deletes a project and all local work item data connected to it.
     */
    deleteProject(id: string): void {
      requireProject(id)
      const workItemIds = new Set(state.workItems.filter(item => item.projectId === id).map(item => item.id))
      state.projects = state.projects.filter(item => item.id !== id)
      state.workItems = state.workItems.filter(item => item.projectId !== id)
      state.comments = state.comments.filter(item => !workItemIds.has(item.workItemId))
      state.runs = state.runs.filter(item => !workItemIds.has(item.workItemId))
      commit()
    },

    /**
     * Deletes one work item and its local comments/run records.
     */
    deleteWorkItem(id: string): void {
      requireWorkItem(id)
      state.workItems = state.workItems.filter(item => item.id !== id)
      state.comments = state.comments.filter(item => item.workItemId !== id)
      state.runs = state.runs.filter(item => item.workItemId !== id)
      commit()
    },

    /**
     * Creates a work item or reports a duplicate identifier conflict.
     */
    createWorkItem(payload: CreateProjectWorkItemPayload): CreateProjectWorkItemResult {
      requireProject(payload.projectId)
      const identifier = normalizeWorkItemIdentifier(payload.identifier)
      const existing = state.workItems.find(item => item.identifier === identifier)
      if (existing && !payload.allowDuplicateIdentifier) {
        return {
          duplicate: true,
          existing,
        }
      }

      if (hasDuplicateIdentifier(state.workItems.map(item => item.identifier), identifier) && !payload.allowDuplicateIdentifier) {
        return { duplicate: true }
      }

      const now = options.now()
      const workItem: WorkItem = {
        id: options.generateId(),
        projectId: payload.projectId,
        identifier,
        title: payload.title.trim(),
        goal: payload.goal.trim(),
        acceptanceCriteria: payload.acceptanceCriteria.map(item => item.trim()).filter(Boolean),
        commitPrefix: payload.commitPrefix?.trim() || undefined,
        status: 'todo',
        position: state.workItems.filter(item => item.projectId === payload.projectId).length,
        dueAt: payload.dueAt,
        createdAt: now,
        updatedAt: now,
      }
      state.workItems.push(workItem)
      commit()
      return {
        duplicate: false,
        workItem,
      }
    },

    /**
     * Updates a work item and emits a status-change notification when needed.
     */
    updateWorkItem(payload: UpdateProjectWorkItemPayload): WorkItem {
      const index = state.workItems.findIndex(item => item.id === payload.id)
      if (index < 0)
        throw new Error(`Work item not found: ${payload.id}`)

      const previous = state.workItems[index]
      const next: WorkItem = {
        ...previous,
        ...payload.patch,
        acceptanceCriteria: payload.patch.acceptanceCriteria ?? previous.acceptanceCriteria,
        commitPrefix: payload.patch.commitPrefix === null ? undefined : payload.patch.commitPrefix?.trim() || previous.commitPrefix,
        dueAt: payload.patch.dueAt === null ? undefined : payload.patch.dueAt ?? previous.dueAt,
        updatedAt: options.now(),
      }
      state.workItems[index] = next
      commit()

      if (next.status !== previous.status) {
        options.notifyStatusChange?.(next, previous.status)
      }

      return next
    },

    /**
     * Adds a compact comment or execution note to a work item.
     */
    addComment(payload: AddProjectWorkItemCommentPayload): WorkItemComment {
      requireWorkItem(payload.workItemId)
      const comment: WorkItemComment = {
        id: options.generateId(),
        workItemId: payload.workItemId,
        actorType: payload.actorType,
        kind: payload.kind,
        content: payload.content.trim(),
        createdAt: options.now(),
      }
      state.comments.push(comment)
      commit()
      return comment
    },

    /**
     * Inserts or replaces a worker/reviewer run summary.
     */
    upsertRunRecord(run: WorkItemRunRecord): WorkItemRunRecord {
      requireWorkItem(run.workItemId)
      const index = state.runs.findIndex(item => item.id === run.id)
      if (index >= 0) {
        state.runs[index] = run
      }
      else {
        state.runs.push(run)
      }
      commit()
      return run
    },

    /**
     * Merges global project manager/worker/reviewer settings.
     */
    updateSettings(patch: Partial<ProjectAgentSettings>): ProjectAgentSettings {
      state.settings = mergeProjectAgentSettings(state.settings, patch)
      commit()
      return state.settings
    },
  }
}

/** Store facade returned by {@link createProjectManagementStore}. */
export type ProjectManagementStore = ReturnType<typeof createProjectManagementStore>
