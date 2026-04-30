<script setup lang="ts">
import type { Project, WorkItem, WorkItemStatus } from '@proj-airi/stage-projects'

import type { ProjectWorkItemFormPayload } from '../utils/project-dashboard-model'

import { createNextWorkItemIdentifier, WORK_ITEM_STATUSES } from '@proj-airi/stage-projects'
import { Button, FieldInput, FieldSelect, FieldTextArea } from '@proj-airi/ui'
import { computed, reactive, watch } from 'vue'

import { projectDashboardStatusMeta } from '../utils/project-dashboard-model'

type DialogMode = 'create' | 'edit'

const props = defineProps<{
  open: boolean
  mode: DialogMode
  projects: Project[]
  workItems: WorkItem[]
  workItem?: WorkItem
  defaultProjectId: string | null
  busy?: boolean
}>()

const emit = defineEmits<{
  close: []
  submit: [payload: ProjectWorkItemFormPayload]
}>()

const form = reactive({
  projectId: '',
  identifier: '',
  title: '',
  goal: '',
  acceptanceCriteriaText: '',
  commitPrefix: '',
  status: 'todo' as WorkItemStatus,
})

const projectOptions = computed(() => props.projects.map(project => ({
  label: `${project.name} · ${project.issuePrefix}`,
  value: project.id,
  description: project.rootPath,
  icon: project.gitEnabled ? 'i-solar:branching-paths-down-bold-duotone' : 'i-solar:folder-with-files-bold-duotone',
})))

const statusOptions = computed(() => WORK_ITEM_STATUSES.map(status => ({
  label: projectDashboardStatusMeta[status].label,
  value: status,
  icon: projectDashboardStatusMeta[status].icon,
})))

const acceptanceCriteria = computed(() =>
  form.acceptanceCriteriaText
    .split('\n')
    .map(item => item.trim())
    .filter(Boolean),
)

const title = computed(() => props.mode === 'edit' ? '일감 편집' : '새 일감')
const description = computed(() => props.mode === 'edit'
  ? '목표, 완료 조건, 상태를 정리해 AIRI 실행 기준을 또렷하게 유지해.'
  : 'Cursor agent-kanban처럼 프롬프트를 카드로 만들되, AIRI가 실행할 목표와 완료 조건까지 함께 적어둬.')

const canSubmit = computed(() =>
  !!form.projectId
  && !!form.identifier.trim()
  && !!form.title.trim()
  && !!form.goal.trim()
  && acceptanceCriteria.value.length > 0,
)

function createIdentifier(projectId: string): string {
  const project = props.projects.find(item => item.id === projectId) ?? props.projects[0]
  if (!project)
    return ''

  return createNextWorkItemIdentifier({
    issuePrefix: project.issuePrefix,
    identifiers: props.workItems
      .filter(item => item.projectId === project.id)
      .map(item => item.identifier),
  })
}

function resolveInitialProjectId(): string {
  return props.workItem?.projectId
    ?? props.defaultProjectId
    ?? props.projects[0]?.id
    ?? ''
}

function resetForm() {
  const projectId = resolveInitialProjectId()
  form.projectId = projectId

  if (props.mode === 'edit' && props.workItem) {
    form.identifier = props.workItem.identifier
    form.title = props.workItem.title
    form.goal = props.workItem.goal
    form.acceptanceCriteriaText = props.workItem.acceptanceCriteria.join('\n')
    form.commitPrefix = props.workItem.commitPrefix ?? ''
    form.status = props.workItem.status
    return
  }

  form.identifier = createIdentifier(projectId)
  form.title = ''
  form.goal = ''
  form.acceptanceCriteriaText = ''
  form.commitPrefix = ''
  form.status = 'todo'
}

function handleSubmit() {
  if (!canSubmit.value)
    return

  emit('submit', {
    projectId: form.projectId,
    workItemId: props.mode === 'edit' ? props.workItem?.id : undefined,
    identifier: form.identifier,
    title: form.title,
    goal: form.goal,
    acceptanceCriteria: acceptanceCriteria.value,
    commitPrefix: form.commitPrefix,
    status: props.mode === 'edit' ? form.status : undefined,
  })
}

watch(
  () => [props.open, props.mode, props.workItem?.id, props.defaultProjectId, props.projects.length] as const,
  () => {
    if (props.open)
      resetForm()
  },
  { immediate: true },
)

watch(
  () => form.projectId,
  (projectId) => {
    if (props.mode === 'create')
      form.identifier = createIdentifier(projectId)
  },
)
</script>

<template>
  <div
    v-if="props.open"
    :class="[
      'fixed inset-0 z-50 grid place-items-center bg-neutral-950/45 p-4 backdrop-blur-sm',
    ]"
  >
    <section
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      :class="[
        'max-h-[92dvh] w-full max-w-2xl overflow-hidden rounded-lg border shadow-2xl',
        'border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950',
      ]"
    >
      <header
        :class="[
          'flex items-start justify-between gap-4 border-b px-5 py-4',
          'border-neutral-200 bg-neutral-50/80 dark:border-neutral-800 dark:bg-neutral-900/70',
        ]"
      >
        <div :class="['min-w-0']">
          <h2 :class="['text-lg font-semibold text-neutral-950 dark:text-neutral-50']">
            {{ title }}
          </h2>
          <p :class="['mt-1 text-sm leading-6 text-neutral-500 dark:text-neutral-400']">
            {{ description }}
          </p>
        </div>
        <Button
          icon="i-solar:close-circle-bold"
          size="sm"
          shape="square"
          variant="ghost"
          aria-label="닫기"
          @click="emit('close')"
        />
      </header>

      <form
        :class="['grid max-h-[calc(92dvh-88px)] gap-4 overflow-y-auto p-5']"
        @submit.prevent="handleSubmit"
      >
        <div :class="['grid gap-3 md:grid-cols-[1fr_180px]']">
          <FieldSelect
            v-model="form.projectId"
            layout="vertical"
            label="프로젝트"
            :options="projectOptions"
            :disabled="props.mode === 'edit'"
            placeholder="프로젝트 선택"
          />
          <FieldInput
            v-model="form.identifier"
            layout="vertical"
            label="Identifier"
            placeholder="AIRI-12"
            :disabled="props.mode === 'edit'"
          />
        </div>

        <FieldInput
          v-model="form.title"
          layout="vertical"
          label="제목"
          placeholder="프로젝트 보드 UX 다듬기"
        />

        <FieldTextArea
          v-model="form.goal"
          label="목표"
          :rows="4"
          placeholder="사용자가 대시보드에서 진행 상태와 다음 액션을 빠르게 판단할 수 있게 한다."
        />

        <FieldTextArea
          v-model="form.acceptanceCriteriaText"
          label="완료 조건"
          description="한 줄에 하나씩 입력"
          :rows="5"
          placeholder="상태별 칸반 컬럼이 보인다&#10;카드에서 최신 실행 메모가 보인다&#10;TODO 일감을 시작할 수 있다"
        />

        <div :class="['grid gap-3 md:grid-cols-2']">
          <FieldInput
            v-model="form.commitPrefix"
            layout="vertical"
            label="Commit prefix"
            placeholder="feat:"
          />
          <FieldSelect
            v-if="props.mode === 'edit'"
            v-model="form.status"
            layout="vertical"
            label="상태"
            :options="statusOptions"
          />
        </div>

        <div
          :class="[
            'flex flex-wrap items-center justify-end gap-2 border-t pt-4',
            'border-neutral-200 dark:border-neutral-800',
          ]"
        >
          <Button
            label="취소"
            variant="secondary"
            :disabled="props.busy"
            @click="emit('close')"
          />
          <Button
            icon="i-solar:diskette-bold"
            :label="props.mode === 'edit' ? '저장' : '추가'"
            type="submit"
            :loading="props.busy"
            :disabled="!canSubmit || props.busy"
          />
        </div>
      </form>
    </section>
  </div>
</template>
