import type {
  StartProjectWorkItemPayload,
  StartProjectWorkItemResult,
} from '../../../../shared/eventa/project-management'

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import {
  agentModelConfigSchema,
  projectSchema,
  workItemCommentSchema,
  workItemRunRecordSchema,
  workItemSchema,
} from '@proj-airi/stage-projects'
import { ipcMain } from 'electron'

import * as v from 'valibot'

import {
  projectManagementAddComment,
  projectManagementCreateWorkItem,
  projectManagementDeleteProject,
  projectManagementDeleteWorkItem,
  projectManagementGetSnapshot,
  projectManagementListCodexCliModels,
  projectManagementRegisterProject,
  projectManagementSnapshotChanged,
  projectManagementStartWorkItem,
  projectManagementUpdateSettings,
  projectManagementUpdateWorkItem,
  projectManagementUpsertRunRecord,
  projectManagementWorkItemStatusChanged,
} from '../../../../shared/eventa/project-management'
import { createConfig } from '../../../libs/electron/persistence'
import { listCodexCliModels } from '../project-runner/agent-runtime'
import { runProjectWorkItem } from '../project-runner/orchestrator'
import { inspectGitDirtyFiles } from '../project-runner/tools'
import {
  createDefaultProjectManagementState,
  createProjectManagementStore,
} from './store'

const log = useLogg('project-management').useGlobalConfig()

/** Schema for global project manager/worker/reviewer settings persisted in Electron userData. */
export const projectAgentSettingsPersistenceSchema = v.object({
  projectManager: agentModelConfigSchema,
  worker: agentModelConfigSchema,
  reviewer: agentModelConfigSchema,
  maxReviewRetries: v.pipe(v.number(), v.integer(), v.minValue(1)),
  maxConcurrentRuns: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 2),
  autoCommit: v.boolean(),
  verifierCommands: v.optional(v.array(v.string()), []),
  shellDenylist: v.array(v.string()),
  shellAllowlist: v.array(v.string()),
  forbiddenPathPatterns: v.array(v.string()),
  timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
})

/** Schema for the local project-management JSON persistence file. */
export const projectManagementStateSchema = v.object({
  version: v.literal(1),
  projects: v.array(projectSchema),
  workItems: v.array(workItemSchema),
  comments: v.array(workItemCommentSchema),
  runs: v.array(workItemRunRecordSchema),
  settings: projectAgentSettingsPersistenceSchema,
})

/**
 * Checks whether AIRI can start another worker/reviewer run.
 *
 * Use when:
 * - A chat or board action attempts to start a TODO work item
 * - The project runner must enforce the global concurrent worker limit
 *
 * Expects:
 * - `activeRunCount` reflects in-memory runs currently executing in this app process
 * - `maxConcurrentRuns` has already been validated to be at least 1
 *
 * Returns:
 * - `undefined` when another run may start, otherwise a user-facing Korean message
 */
export function getConcurrentRunLimitMessage(activeRunCount: number, maxConcurrentRuns: number): string | undefined {
  if (activeRunCount < maxConcurrentRuns)
    return undefined

  return `이미 ${activeRunCount}개의 일감이 실행 중이야. 현재 동시 실행 최대치는 ${maxConcurrentRuns}개야.`
}

function formatDirtyGitFileLine(line: string): string {
  const status = line.slice(0, 2)
  const path = line.slice(3).trim()
  const label = status === '??'
    ? '추적되지 않음'
    : status.includes('D')
      ? '삭제됨'
      : status.includes('A')
        ? '추가됨'
        : status.includes('R')
          ? '이름 변경됨'
          : '수정됨'
  return `- ${path} (${label})`
}

export function formatDirtyWorktreeStartMessage(identifier: string, dirtyFiles: string[]): string {
  return [
    `${identifier} 작업을 시작하기 전에 확인이 필요해.`,
    '',
    '원본 프로젝트 폴더에 아직 git으로 커밋되지 않은 파일이 있어. AIRI는 별도 worktree에서 작업하지만, 사용자 변경사항을 덮어쓰지 않기 위해 먼저 멈췄어.',
    '',
    '감지된 파일:',
    ...dirtyFiles.map(formatDirtyGitFileLine),
    '',
    `이 파일들이 네가 의도한 변경사항이면 "${identifier} 계속 진행해도 돼"라고 말해줘. 원치 않는 파일이면 먼저 정리한 뒤 다시 시작해줘.`,
  ].join('\n')
}

/**
 * Starts the local project-management service and registers Eventa handlers.
 *
 * Use when:
 * - Electron main boots and renderer/chat tools need project CRUD access
 * - The localhost board needs a shared local data source
 *
 * Expects:
 * - Electron `app.whenReady()` has resolved before persistence uses `userData`
 *
 * Returns:
 * - A store facade used by later runner and board services
 *
 * Call stack:
 *
 * main/index.ts
 *   -> {@link setupProjectManagementService}
 *     -> {@link createProjectManagementStore}
 *       -> Eventa invoke handlers
 */
export async function setupProjectManagementService() {
  const config = createConfig(
    'project-management',
    'v1.json',
    projectManagementStateSchema,
    {
      default: createDefaultProjectManagementState(),
      autoHeal: true,
      onValidationFailure: diagnostics => log.withFields({ path: diagnostics.path }).warn('Project management config was invalid; using defaults.'),
      onReadError: diagnostics => log.withFields({ path: diagnostics.path }).warn('Project management config could not be read; using defaults.'),
    },
  )
  const diagnostics = config.setup()
  const { context } = createContext(ipcMain)
  const activeRunWorkItemIds = new Set<string>()

  const store = createProjectManagementStore(diagnostics.value ?? createDefaultProjectManagementState(), {
    generateId: randomUUID,
    now: () => Date.now(),
    save: state => config.update(state),
    notify: snapshot => context.emit(projectManagementSnapshotChanged, snapshot),
    notifyStatusChange: (workItem, previousStatus) => context.emit(projectManagementWorkItemStatusChanged, { workItem, previousStatus }),
  })

  defineInvokeHandler(context, projectManagementGetSnapshot, async () => store.getSnapshot())

  defineInvokeHandler(context, projectManagementListCodexCliModels, async () => ({
    models: await listCodexCliModels(),
  }))

  defineInvokeHandler(context, projectManagementRegisterProject, async (payload) => {
    return store.registerProject({
      ...payload,
      gitEnabled: payload.gitEnabled ?? existsSync(join(payload.rootPath, '.git')),
    })
  })

  defineInvokeHandler(context, projectManagementDeleteProject, async (payload) => {
    store.deleteProject(payload.id)
  })

  defineInvokeHandler(context, projectManagementDeleteWorkItem, async (payload) => {
    store.deleteWorkItem(payload.id)
  })

  defineInvokeHandler(context, projectManagementCreateWorkItem, async payload => store.createWorkItem(payload))

  defineInvokeHandler(context, projectManagementUpdateWorkItem, async payload => store.updateWorkItem(payload))

  /**
   * Starts a TODO work item by validating board state and launching the runner.
   *
   * Use when:
   * - AIRI chat asks to begin an issue
   * - The local project board Start button begins an issue
   *
   * Expects:
   * - Work item exists by id or identifier
   * - The original project folder is clean unless explicitly allowed
   *
   * Returns:
   * - A user-facing start result and the inspected work item when available
   *
   * Call stack:
   *
   * setupProjectManagementService
   *   -> {@link startWorkItem}
   *     -> {@link runProjectWorkItem}
   */
  const startWorkItem = async (payload: StartProjectWorkItemPayload): Promise<StartProjectWorkItemResult> => {
    const snapshot = store.getSnapshot()
    const foundWorkItem = payload.workItemId
      ? snapshot.workItems.find(item => item.id === payload.workItemId)
      : snapshot.workItems.find(item => item.identifier === payload.identifier?.trim().toUpperCase())

    if (!foundWorkItem) {
      return {
        started: false,
        message: payload.identifier
          ? `일감 ${payload.identifier.trim().toUpperCase()}을 찾지 못했어.`
          : '시작할 일감을 찾지 못했어.',
      }
    }
    let workItem = foundWorkItem

    const missingFields: Array<'goal' | 'acceptanceCriteria'> = []
    if (!workItem.goal.trim())
      missingFields.push('goal')
    if (workItem.acceptanceCriteria.length === 0)
      missingFields.push('acceptanceCriteria')

    if (missingFields.length > 0) {
      return {
        started: false,
        workItem,
        missingFields,
        message: `${workItem.identifier}를 시작하기 전에 ${missingFields.includes('goal') ? '목표' : ''}${missingFields.length > 1 ? '와 ' : ''}${missingFields.includes('acceptanceCriteria') ? '완료 조건' : ''}이 필요해. 목표와 완료 조건을 알려줘.`,
      }
    }

    if (workItem.status !== 'todo') {
      return {
        started: false,
        workItem,
        message: `${workItem.identifier}는 현재 ${workItem.status} 상태라서 TODO 일감처럼 새로 시작하지 않았어.`,
      }
    }

    let project = snapshot.projects.find(item => item.id === workItem.projectId)
    if (!project) {
      return {
        started: false,
        workItem,
        message: `${workItem.identifier}의 프로젝트를 찾지 못했어.`,
      }
    }

    if (project.gitEnabled && !payload.allowDirtyWorktree) {
      const dirty = await inspectGitDirtyFiles(project.rootPath)
      if (dirty.dirty) {
        return {
          started: false,
          workItem,
          dirtyFiles: dirty.files,
          message: formatDirtyWorktreeStartMessage(workItem.identifier, dirty.files),
        }
      }
    }

    if (activeRunWorkItemIds.has(workItem.id)) {
      return {
        started: false,
        workItem,
        message: `${workItem.identifier}는 이미 실행 중이야.`,
      }
    }

    const latestSnapshot = store.getSnapshot()
    const latestWorkItem = latestSnapshot.workItems.find(item => item.id === workItem.id)
    if (!latestWorkItem) {
      return {
        started: false,
        message: `${workItem.identifier} 일감이 시작 직전에 삭제됐어.`,
      }
    }
    workItem = latestWorkItem
    project = latestSnapshot.projects.find(item => item.id === workItem.projectId)
    if (!project) {
      return {
        started: false,
        workItem,
        message: `${workItem.identifier}의 프로젝트가 시작 직전에 삭제됐어.`,
      }
    }
    if (workItem.status !== 'todo') {
      return {
        started: false,
        workItem,
        message: `${workItem.identifier}는 현재 ${workItem.status} 상태라서 TODO 일감처럼 새로 시작하지 않았어.`,
      }
    }

    const settings = store.getSnapshot().settings
    const concurrentLimitMessage = getConcurrentRunLimitMessage(activeRunWorkItemIds.size, settings.maxConcurrentRuns)
    if (concurrentLimitMessage) {
      return {
        started: false,
        workItem,
        message: concurrentLimitMessage,
      }
    }

    const started = store.updateWorkItem({
      id: workItem.id,
      patch: { status: 'in_progress' },
    })
    store.addComment({
      workItemId: workItem.id,
      actorType: 'airi',
      kind: 'status',
      content: 'Your Master가 이 일감 작업을 시작했어.',
    })

    activeRunWorkItemIds.add(started.id)
    void runProjectWorkItem({
      generateId: randomUUID,
      now: () => Date.now(),
      project,
      settings,
      store,
      workItem: started,
    }).finally(() => {
      activeRunWorkItemIds.delete(started.id)
    })

    return {
      started: true,
      workItem: started,
      message: `${started.identifier} 작업을 시작했어. worktree 기반으로 워커 에이전트에게 맡겼어.`,
    }
  }

  defineInvokeHandler(context, projectManagementStartWorkItem, startWorkItem)

  defineInvokeHandler(context, projectManagementAddComment, async payload => store.addComment(payload))

  defineInvokeHandler(context, projectManagementUpsertRunRecord, async payload => store.upsertRunRecord(payload.run))

  defineInvokeHandler(context, projectManagementUpdateSettings, async payload => store.updateSettings(payload))

  return {
    ...store,
    startWorkItem,
  }
}
