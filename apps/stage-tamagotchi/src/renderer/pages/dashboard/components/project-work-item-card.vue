<script setup lang="ts">
import type { ProjectDashboardCard } from '../utils/project-dashboard-model'

import { Button } from '@proj-airi/ui'
import { computed } from 'vue'

import ProjectStatusBadge from './project-status-badge.vue'

const props = defineProps<{
  card: ProjectDashboardCard
  selected: boolean
  busy?: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  start: [id: string]
  edit: [id: string]
}>()

const changedFilesLabel = computed(() => {
  const count = props.card.latestRun?.changedFiles.length ?? 0
  if (count === 0)
    return ''
  return `${count} files`
})

const subtaskLabel = computed(() => {
  const tasks = props.card.latestRun?.subtaskProgress ?? []
  if (tasks.length === 0)
    return ''

  const done = tasks.filter(task => task.status === 'done').length
  return `${done}/${tasks.length} subtasks`
})

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== ' ')
    return

  event.preventDefault()
  emit('select', props.card.item.id)
}
</script>

<template>
  <article
    role="button"
    tabindex="0"
    :aria-pressed="props.selected"
    :class="[
      'group relative grid gap-3 rounded-lg border p-3 text-left outline-none transition',
      'bg-white/85 shadow-sm backdrop-blur dark:bg-neutral-900/70',
      props.selected
        ? 'border-primary-400/50 ring-2 ring-primary-300/30 dark:border-primary-400/40 dark:ring-primary-400/20'
        : 'border-neutral-200/80 hover:border-neutral-300 dark:border-neutral-800/80 dark:hover:border-neutral-700',
    ]"
    @click="emit('select', props.card.item.id)"
    @keydown.self="handleKeydown"
  >
    <div
      :class="[
        'absolute inset-y-3 left-0 w-1 rounded-r-full',
        props.card.item.status === 'todo' ? 'bg-neutral-400' : '',
        props.card.item.status === 'in_progress' ? 'bg-amber-500' : '',
        props.card.item.status === 'in_review' ? 'bg-violet-500' : '',
        props.card.item.status === 'done' ? 'bg-emerald-500' : '',
        props.card.item.status === 'blocked' ? 'bg-red-500' : '',
      ]"
    />

    <div :class="['flex items-start justify-between gap-3']">
      <div :class="['min-w-0 flex-1']">
        <div :class="['truncate text-[11px] font-semibold text-neutral-500 dark:text-neutral-400']">
          {{ props.card.item.identifier }}
        </div>
        <h3 :class="['mt-1 line-clamp-2 text-sm font-semibold leading-5 text-neutral-950 dark:text-neutral-50']">
          {{ props.card.item.title }}
        </h3>
      </div>
      <ProjectStatusBadge :status="props.card.item.status" compact />
    </div>

    <p
      v-if="props.card.previewText"
      :class="['line-clamp-2 text-xs leading-5 text-neutral-600 dark:text-neutral-300']"
    >
      {{ props.card.previewText }}
    </p>

    <div :class="['flex flex-wrap gap-1.5']">
      <span
        v-if="props.card.project"
        :class="[
          'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-1 text-[11px]',
          'border-neutral-200 bg-neutral-50 text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300',
        ]"
      >
        <span :class="['i-solar:folder-with-files-bold-duotone size-3 shrink-0']" />
        <span :class="['truncate']">{{ props.card.project.name }}</span>
      </span>
      <span
        v-if="props.card.latestRun?.branchName"
        :class="[
          'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-1 text-[11px]',
          'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200',
        ]"
      >
        <span :class="['i-solar:branching-paths-down-bold-duotone size-3 shrink-0']" />
        <span :class="['truncate']">{{ props.card.latestRun.branchName }}</span>
      </span>
      <span
        v-if="changedFilesLabel"
        :class="[
          'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px]',
          'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-200',
        ]"
      >
        <span :class="['i-solar:file-check-bold-duotone size-3']" />
        {{ changedFilesLabel }}
      </span>
      <span
        v-if="subtaskLabel"
        :class="[
          'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px]',
          'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200',
        ]"
      >
        <span :class="['i-solar:checklist-minimalistic-bold-duotone size-3']" />
        {{ subtaskLabel }}
      </span>
    </div>

    <div :class="['flex items-center justify-between gap-2 border-t border-neutral-100 pt-2 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400']">
      <span :class="['inline-flex min-w-0 items-center gap-1']">
        <span :class="['i-solar:clock-circle-bold-duotone size-3.5 shrink-0']" />
        <span :class="['truncate']">{{ props.card.activityLabel }}</span>
      </span>
      <div :class="['flex shrink-0 items-center gap-1']">
        <Button
          v-if="props.card.item.status === 'todo'"
          icon="i-solar:play-circle-bold"
          label="시작"
          size="sm"
          variant="secondary"
          :disabled="props.busy"
          @click.stop="emit('start', props.card.item.id)"
        />
        <Button
          icon="i-solar:pen-bold"
          size="sm"
          shape="square"
          variant="ghost"
          :disabled="props.busy"
          aria-label="일감 편집"
          @click.stop="emit('edit', props.card.item.id)"
        />
      </div>
    </div>
  </article>
</template>
