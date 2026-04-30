<script setup lang="ts">
import type { ProjectWorkItemFormPayload } from './utils/project-dashboard-model'

import { errorMessageFrom } from '@moeru/std'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { computed, shallowRef } from 'vue'

import ProjectDashboardShell from './components/project-dashboard-shell.vue'
import ProjectDashboardSkeleton from './components/project-dashboard-skeleton.vue'
import ProjectWorkItemDialog from './components/project-work-item-dialog.vue'

import {
  electronOpenSettings,
  projectManagementOpenBoardExternal,
} from '../../../shared/eventa'
import { useProjectDashboard } from './composables/use-project-dashboard'

type WorkItemDialogMode = 'create' | 'edit'

const dashboard = useProjectDashboard()
const {
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
} = dashboard

const openSettings = useElectronEventaInvoke(electronOpenSettings)
const openExternalBoard = useElectronEventaInvoke(projectManagementOpenBoardExternal)
const dialogMode = shallowRef<WorkItemDialogMode>('create')
const isDialogOpen = shallowRef(false)
const editingWorkItemId = shallowRef<string | null>(null)

const editingWorkItem = computed(() => {
  if (!editingWorkItemId.value)
    return undefined

  return snapshot.value?.workItems.find(item => item.id === editingWorkItemId.value)
})

const defaultDialogProjectId = computed(() =>
  selectedProjectId.value
  ?? viewModel.value.projects[0]?.id
  ?? null,
)

function openCreateDialog() {
  dialogMode.value = 'create'
  editingWorkItemId.value = null
  isDialogOpen.value = true
}

function openEditDialog(workItemId: string) {
  selectWorkItem(workItemId)
  dialogMode.value = 'edit'
  editingWorkItemId.value = workItemId
  isDialogOpen.value = true
}

function closeDialog() {
  isDialogOpen.value = false
}

async function handleSaveWorkItem(payload: ProjectWorkItemFormPayload) {
  try {
    await saveWorkItem(payload)
    closeDialog()
  }
  catch {
    // The composable already surfaces a user-facing error message; keep the dialog open.
  }
}

async function handleDeleteWorkItem(workItemId: string) {
  try {
    await deleteWorkItem(workItemId)
  }
  catch {
    // The composable already surfaces a user-facing error message.
  }
}

async function handleOpenSettings() {
  try {
    await openSettings({ route: '/settings/project-management' })
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? '프로젝트 관리 설정을 열지 못했어.'
  }
}

async function handleOpenExternalBoard() {
  try {
    const result = await openExternalBoard()
    if (result.opened) {
      statusMessage.value = '외부 프로젝트 보드를 열었어.'
      return
    }

    errorMessage.value = '외부 프로젝트 보드 주소를 아직 만들지 못했어.'
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? '외부 프로젝트 보드를 열지 못했어.'
  }
}
</script>

<template>
  <ProjectDashboardSkeleton v-if="isLoading && !snapshot" />
  <ProjectDashboardShell
    v-else
    v-model:query="query"
    v-model:filter="filter"
    v-model:group-by="groupBy"
    :view-model="viewModel"
    :selected-project-id="selectedProjectId"
    :selected-work-item-id="selectedWorkItemId"
    :is-refreshing="isRefreshing"
    :is-busy="isBusy"
    :status-message="statusMessage"
    :error-message="errorMessage"
    @refresh="refreshSnapshot"
    @create="openCreateDialog"
    @open-settings="handleOpenSettings"
    @open-external-board="handleOpenExternalBoard"
    @select-project="selectProject"
    @select-work-item="selectWorkItem"
    @start-work-item="startWorkItem"
    @edit-work-item="openEditDialog"
    @delete-work-item="handleDeleteWorkItem"
  />

  <ProjectWorkItemDialog
    :open="isDialogOpen"
    :mode="dialogMode"
    :projects="viewModel.projects"
    :work-items="snapshot?.workItems ?? []"
    :work-item="editingWorkItem"
    :default-project-id="defaultDialogProjectId"
    :busy="isBusy"
    @close="closeDialog"
    @submit="handleSaveWorkItem"
  />
</template>

<route lang="yaml">
meta:
  layout: default
</route>
