import type {
  ProjectManagementSnapshot,
  UpdateProjectWorkItemPayload,
} from '../../../../shared/eventa/project-management'
import type {
  ProjectDashboardFilter,
  ProjectDashboardGroupBy,
  ProjectWorkItemFormPayload,
} from '../utils/project-dashboard-model'

import { errorMessageFrom } from '@moeru/std'
import { useElectronEventaContext, useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { computed, onMounted, onUnmounted, shallowRef } from 'vue'

import {
  projectManagementCreateWorkItem,
  projectManagementDeleteWorkItem,
  projectManagementGetSnapshot,
  projectManagementSnapshotChanged,
  projectManagementStartWorkItem,
  projectManagementUpdateWorkItem,
} from '../../../../shared/eventa'
import {
  createProjectDashboardViewModel,
} from '../utils/project-dashboard-model'

/**
 * Owns project dashboard snapshot loading, realtime updates, and board actions.
 *
 * Use when:
 * - The dashboard route needs a thin composition surface over project-management Eventa APIs
 * - Components should receive derived state through props and send explicit action events upward
 *
 * Expects:
 * - Electron `ipcRenderer` is available through the shared renderer preload
 * - Project-management handlers are registered in Electron main before the dashboard route mounts
 *
 * Returns:
 * - Reactive dashboard state, selected ids, and async actions for create/edit/delete/start flows
 */
export function useProjectDashboard() {
  const context = useElectronEventaContext()
  const getSnapshot = useElectronEventaInvoke(projectManagementGetSnapshot)
  const createWorkItem = useElectronEventaInvoke(projectManagementCreateWorkItem)
  const updateWorkItem = useElectronEventaInvoke(projectManagementUpdateWorkItem)
  const deleteWorkItemInvoke = useElectronEventaInvoke(projectManagementDeleteWorkItem)
  const startWorkItemInvoke = useElectronEventaInvoke(projectManagementStartWorkItem)

  const snapshot = shallowRef<ProjectManagementSnapshot>()
  const selectedProjectId = shallowRef<string | null>(null)
  const selectedWorkItemId = shallowRef<string | null>(null)
  const query = shallowRef('')
  const filter = shallowRef<ProjectDashboardFilter>('all')
  const groupBy = shallowRef<ProjectDashboardGroupBy>('status')
  const isLoading = shallowRef(true)
  const isRefreshing = shallowRef(false)
  const isBusy = shallowRef(false)
  const errorMessage = shallowRef('')
  const statusMessage = shallowRef('')
  const now = shallowRef(Date.now())
  let stopSnapshotListener: (() => void) | undefined
  let clockTimer: ReturnType<typeof setInterval> | undefined

  const viewModel = computed(() => createProjectDashboardViewModel({
    snapshot: snapshot.value,
    selectedProjectId: selectedProjectId.value,
    selectedWorkItemId: selectedWorkItemId.value,
    query: query.value,
    filter: filter.value,
    groupBy: groupBy.value,
    now: now.value,
  }))

  async function refreshSnapshot(options: { silent?: boolean } = {}) {
    if (!options.silent)
      isRefreshing.value = true
    errorMessage.value = ''

    try {
      applySnapshot(await getSnapshot())
    }
    catch (error) {
      errorMessage.value = errorMessageFrom(error) ?? '프로젝트 대시보드를 불러오지 못했어.'
    }
    finally {
      isLoading.value = false
      isRefreshing.value = false
    }
  }

  function applySnapshot(nextSnapshot: ProjectManagementSnapshot) {
    snapshot.value = nextSnapshot

    if (selectedProjectId.value && !nextSnapshot.projects.some(project => project.id === selectedProjectId.value))
      selectedProjectId.value = null

    if (selectedWorkItemId.value && !nextSnapshot.workItems.some(item => item.id === selectedWorkItemId.value))
      selectedWorkItemId.value = null
  }

  function selectProject(projectId: string | null) {
    selectedProjectId.value = projectId
    selectedWorkItemId.value = null
  }

  function selectWorkItem(workItemId: string | null) {
    selectedWorkItemId.value = workItemId
  }

  async function saveWorkItem(payload: ProjectWorkItemFormPayload) {
    const workItemId = payload.workItemId
    if (workItemId) {
      await runMutation(async () => {
        const patch: UpdateProjectWorkItemPayload['patch'] = {
          title: payload.title.trim(),
          goal: payload.goal.trim(),
          acceptanceCriteria: payload.acceptanceCriteria,
          commitPrefix: payload.commitPrefix?.trim() ? payload.commitPrefix.trim() : null,
        }
        if (payload.status)
          patch.status = payload.status

        const updated = await updateWorkItem({
          id: workItemId,
          patch,
        })
        selectedWorkItemId.value = updated.id
      }, '일감이 저장됐어.')
      return
    }

    await runMutation(async () => {
      const result = await createWorkItem({
        projectId: payload.projectId,
        identifier: payload.identifier.trim(),
        title: payload.title.trim(),
        goal: payload.goal.trim(),
        acceptanceCriteria: payload.acceptanceCriteria,
        commitPrefix: payload.commitPrefix?.trim() || undefined,
      })
      if (result.duplicate || !result.workItem) {
        throw new Error(result.existing
          ? `${result.existing.identifier}가 이미 있어. 다른 identifier를 입력해줘.`
          : '같은 identifier의 일감이 이미 있어.')
      }

      selectedProjectId.value = result.workItem.projectId
      selectedWorkItemId.value = result.workItem.id
    }, '새 일감이 추가됐어.')
  }

  async function deleteWorkItem(id: string) {
    await runMutation(async () => {
      await deleteWorkItemInvoke({ id })
      if (selectedWorkItemId.value === id)
        selectedWorkItemId.value = null
    }, '일감이 삭제됐어.')
  }

  async function startWorkItem(id: string) {
    isBusy.value = true
    errorMessage.value = ''
    statusMessage.value = ''

    try {
      const result = await startWorkItemInvoke({ workItemId: id })
      if (result.started)
        statusMessage.value = result.message
      else
        errorMessage.value = result.message
      await refreshSnapshot({ silent: true })
    }
    catch (error) {
      errorMessage.value = errorMessageFrom(error) ?? '일감 시작에 실패했어.'
    }
    finally {
      isBusy.value = false
    }
  }

  async function runMutation(action: () => Promise<void>, successMessage: string) {
    isBusy.value = true
    errorMessage.value = ''
    statusMessage.value = ''

    try {
      await action()
      await refreshSnapshot({ silent: true })
      statusMessage.value = successMessage
    }
    catch (error) {
      errorMessage.value = errorMessageFrom(error) ?? '프로젝트 작업을 처리하지 못했어.'
      throw error
    }
    finally {
      isBusy.value = false
    }
  }

  onMounted(async () => {
    // Keep relative activity labels fresh without making every render call Date.now().
    clockTimer = setInterval(() => {
      now.value = Date.now()
    }, 60_000)

    await refreshSnapshot()

    try {
      stopSnapshotListener = context.value.on(projectManagementSnapshotChanged, (event) => {
        if (event.body)
          applySnapshot(event.body)
      })
    }
    catch (error) {
      console.warn('[dashboard] Failed to subscribe to project-management snapshots:', errorMessageFrom(error) ?? 'unknown error')
    }
  })

  onUnmounted(() => {
    stopSnapshotListener?.()
    if (clockTimer)
      clearInterval(clockTimer)
  })

  return {
    snapshot,
    selectedProjectId,
    selectedWorkItemId,
    query,
    filter,
    groupBy,
    isLoading,
    isRefreshing,
    isBusy,
    errorMessage,
    statusMessage,
    viewModel,
    refreshSnapshot,
    saveWorkItem,
    deleteWorkItem,
    startWorkItem,
    selectProject,
    selectWorkItem,
  }
}
