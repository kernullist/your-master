<script setup lang="ts">
import type { Project } from '@proj-airi/stage-projects'

import type {
  ProjectDashboardFilter,
  ProjectDashboardMetrics,
} from '../utils/project-dashboard-model'

import { Button } from '@proj-airi/ui'

import { projectDashboardFilterOptions } from '../utils/project-dashboard-model'

const props = defineProps<{
  projects: Project[]
  selectedProjectId: string | null
  filter: ProjectDashboardFilter
  metrics: ProjectDashboardMetrics
  filterCounts: Record<ProjectDashboardFilter, number>
  busy?: boolean
}>()

const emit = defineEmits<{
  selectProject: [id: string | null]
  selectFilter: [id: ProjectDashboardFilter]
  create: []
  openSettings: []
}>()
</script>

<template>
  <aside
    :class="[
      'min-h-0 border-r p-3',
      'border-neutral-200 bg-neutral-950 text-neutral-100 dark:border-neutral-800 dark:bg-neutral-950',
      'grid grid-rows-[auto_auto_auto_minmax(0,1fr)] gap-3',
    ]"
  >
    <div :class="['flex items-center gap-3 px-1']">
      <div :class="['grid size-9 place-items-center rounded-lg bg-primary-400/20 text-primary-100']">
        <span :class="['i-solar:kanban-bold-duotone size-5']" />
      </div>
      <div :class="['min-w-0 flex-1']">
        <h1 :class="['truncate text-sm font-semibold']">
          Project Dashboard
        </h1>
        <p :class="['truncate text-xs text-neutral-400']">
          AIRI local workers
        </p>
      </div>
    </div>

    <div :class="['grid grid-cols-2 gap-2']">
      <div :class="['rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2']">
        <strong :class="['block text-xl leading-none']">{{ props.metrics.active }}</strong>
        <span :class="['text-[11px] text-neutral-400']">활성</span>
      </div>
      <div :class="['rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2']">
        <strong :class="['block text-xl leading-none']">{{ props.metrics.blocked }}</strong>
        <span :class="['text-[11px] text-neutral-400']">막힘</span>
      </div>
    </div>

    <div :class="['grid grid-cols-2 gap-2']">
      <Button
        icon="i-solar:add-circle-bold"
        label="새 일감"
        size="sm"
        block
        :disabled="props.busy || props.projects.length === 0"
        @click="emit('create')"
      />
      <Button
        icon="i-solar:settings-bold"
        label="설정"
        size="sm"
        variant="secondary"
        block
        @click="emit('openSettings')"
      />
    </div>

    <div :class="['min-h-0 overflow-y-auto pr-1']">
      <div :class="['mb-2 flex items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500']">
        <span>Filters</span>
        <span>{{ props.metrics.total }}</span>
      </div>
      <div :class="['grid gap-1']">
        <button
          v-for="option in projectDashboardFilterOptions"
          :key="option.id"
          type="button"
          :class="[
            'flex items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-sm transition',
            props.filter === option.id
              ? 'bg-neutral-800 text-white shadow-inner'
              : 'text-neutral-300 hover:bg-neutral-900 hover:text-white',
          ]"
          @click="emit('selectFilter', option.id)"
        >
          <span :class="['min-w-0 flex items-center gap-2']">
            <span :class="['size-4 shrink-0', option.icon]" />
            <span :class="['truncate']">{{ option.label }}</span>
          </span>
          <span :class="['rounded-full bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300']">
            {{ props.filterCounts[option.id] }}
          </span>
        </button>
      </div>

      <div :class="['mt-5 mb-2 flex items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500']">
        <span>Projects</span>
        <span>{{ props.projects.length }}</span>
      </div>
      <div :class="['grid gap-1']">
        <button
          type="button"
          :class="[
            'grid gap-1 rounded-lg px-2 py-2 text-left transition',
            props.selectedProjectId === null
              ? 'bg-neutral-800 text-white shadow-inner'
              : 'text-neutral-300 hover:bg-neutral-900 hover:text-white',
          ]"
          @click="emit('selectProject', null)"
        >
          <span :class="['flex items-center gap-2 text-sm font-medium']">
            <span :class="['i-solar:widget-4-bold-duotone size-4']" />
            전체 프로젝트
          </span>
          <span :class="['text-xs text-neutral-500']">등록된 모든 일감</span>
        </button>

        <button
          v-for="project in props.projects"
          :key="project.id"
          type="button"
          :class="[
            'grid gap-1 rounded-lg px-2 py-2 text-left transition',
            props.selectedProjectId === project.id
              ? 'bg-neutral-800 text-white shadow-inner'
              : 'text-neutral-300 hover:bg-neutral-900 hover:text-white',
          ]"
          @click="emit('selectProject', project.id)"
        >
          <span :class="['min-w-0 flex items-center justify-between gap-2 text-sm font-medium']">
            <span :class="['truncate']">{{ project.name }} · {{ project.issuePrefix }}</span>
            <span
              :class="[
                'size-2 shrink-0 rounded-full',
                project.gitEnabled ? 'bg-emerald-400' : 'bg-neutral-600',
              ]"
            />
          </span>
          <span :class="['truncate text-xs text-neutral-500']">{{ project.rootPath }}</span>
        </button>

        <div
          v-if="props.projects.length === 0"
          :class="['rounded-lg border border-dashed border-neutral-800 px-3 py-5 text-center text-xs text-neutral-500']"
        >
          프로젝트 관리 설정에서 폴더를 등록해.
        </div>
      </div>
    </div>
  </aside>
</template>
