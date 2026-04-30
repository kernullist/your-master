<script setup lang="ts">
import type {
  ProjectDashboardFilter,
  ProjectDashboardGroupBy,
  ProjectDashboardViewModel,
} from '../utils/project-dashboard-model'

import { Button, Input, Select } from '@proj-airi/ui'
import { computed } from 'vue'

import ProjectDashboardBoard from './project-dashboard-board.vue'
import ProjectDashboardSidebar from './project-dashboard-sidebar.vue'
import ProjectWorkItemDetail from './project-work-item-detail.vue'

import { projectDashboardGroupOptions } from '../utils/project-dashboard-model'

const props = defineProps<{
  viewModel: ProjectDashboardViewModel
  selectedProjectId: string | null
  selectedWorkItemId: string | null
  isRefreshing?: boolean
  isBusy?: boolean
  statusMessage?: string
  errorMessage?: string
}>()

const emit = defineEmits<{
  refresh: []
  create: []
  openSettings: []
  openExternalBoard: []
  selectProject: [id: string | null]
  selectWorkItem: [id: string | null]
  startWorkItem: [id: string]
  editWorkItem: [id: string]
  deleteWorkItem: [id: string]
}>()
const query = defineModel<string>('query', { required: true })
const filter = defineModel<ProjectDashboardFilter>('filter', { required: true })
const groupBy = defineModel<ProjectDashboardGroupBy>('groupBy', { required: true })

const selectedProjectTitle = computed(() => {
  const project = props.viewModel.selectedProject
  return project ? `${project.name} · ${project.issuePrefix}` : '전체 프로젝트'
})

const selectedProjectSubtitle = computed(() => {
  const project = props.viewModel.selectedProject
  if (project)
    return project.rootPath
  if (props.viewModel.projects.length === 0)
    return '먼저 프로젝트 폴더를 등록해줘.'
  return `${props.viewModel.projects.length}개 프로젝트의 일감을 한 번에 보고 있어.`
})

const canCreateWorkItem = computed(() => props.viewModel.projects.length > 0)

const groupOptions = computed(() => projectDashboardGroupOptions.map(option => ({
  label: option.label,
  value: option.id,
  icon: option.icon,
})))
</script>

<template>
  <div
    :class="[
      'h-dvh min-h-0 w-full grid grid-cols-[272px_minmax(0,1fr)] overflow-hidden',
      'bg-neutral-100 text-neutral-950 dark:bg-neutral-950 dark:text-neutral-50',
      'max-lg:grid-cols-1 max-lg:grid-rows-[auto_minmax(0,1fr)]',
    ]"
  >
    <ProjectDashboardSidebar
      :projects="props.viewModel.projects"
      :selected-project-id="props.selectedProjectId"
      :filter="filter"
      :metrics="props.viewModel.metrics"
      :filter-counts="props.viewModel.filterCounts"
      :busy="props.isBusy"
      @select-project="emit('selectProject', $event)"
      @select-filter="filter = $event"
      @create="emit('create')"
      @open-settings="emit('openSettings')"
    />

    <main :class="['min-h-0 min-w-0 grid grid-rows-[auto_auto_minmax(0,1fr)]']">
      <header
        :class="[
          'flex items-center justify-between gap-4 border-b px-5 py-3',
          'border-neutral-200 bg-white/85 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/80',
          'max-md:flex-col max-md:items-stretch',
        ]"
      >
        <div :class="['min-w-0']">
          <div :class="['text-xs font-semibold text-neutral-500 dark:text-neutral-400']">
            Projects / Dashboard
          </div>
          <h1 :class="['mt-1 truncate text-xl font-semibold tracking-0 text-neutral-950 dark:text-neutral-50']">
            {{ selectedProjectTitle }}
          </h1>
        </div>
        <div :class="['flex shrink-0 flex-wrap items-center justify-end gap-2']">
          <Button
            icon="i-solar:refresh-bold"
            label="새로고침"
            size="sm"
            variant="secondary"
            :loading="props.isRefreshing"
            @click="emit('refresh')"
          />
          <Button
            icon="i-solar:global-bold"
            label="외부 보드"
            size="sm"
            variant="secondary"
            @click="emit('openExternalBoard')"
          />
          <Button
            icon="i-solar:add-circle-bold"
            label="새 일감"
            size="sm"
            :disabled="props.isBusy || !canCreateWorkItem"
            @click="emit('create')"
          />
        </div>
      </header>

      <section
        :class="[
          'grid grid-cols-[minmax(0,1fr)_minmax(360px,480px)] gap-4 border-b px-5 py-4',
          'border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950',
          'max-xl:grid-cols-1',
        ]"
      >
        <div :class="['min-w-0 grid content-start gap-3']">
          <div :class="['text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400']">
            {{ props.viewModel.selectedProject?.gitEnabled ? 'Git-backed project' : 'Local project scope' }}
          </div>
          <p :class="['m-0 break-words font-mono text-xs leading-5 text-neutral-500 dark:text-neutral-400']">
            {{ selectedProjectSubtitle }}
          </p>
          <div :class="['max-w-xl grid gap-2']">
            <div :class="['flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400']">
              <span>Completion</span>
              <strong>{{ props.viewModel.metrics.progress }}%</strong>
            </div>
            <div :class="['h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800']">
              <div
                :class="['h-full rounded-full bg-gradient-to-r from-primary-500 to-emerald-500']"
                :style="{ width: `${props.viewModel.metrics.progress}%` }"
              />
            </div>
          </div>
        </div>

        <div :class="['grid gap-3']">
          <div :class="['grid grid-cols-4 gap-2 max-sm:grid-cols-2']">
            <div :class="['rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900']">
              <strong :class="['block text-xl leading-none']">{{ props.viewModel.metrics.total }}</strong>
              <span :class="['text-[11px] text-neutral-500 dark:text-neutral-400']">전체</span>
            </div>
            <div :class="['rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-500/10']">
              <strong :class="['block text-xl leading-none text-amber-800 dark:text-amber-100']">{{ props.viewModel.metrics.active }}</strong>
              <span :class="['text-[11px] text-amber-700 dark:text-amber-200']">활성</span>
            </div>
            <div :class="['rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-500/30 dark:bg-emerald-500/10']">
              <strong :class="['block text-xl leading-none text-emerald-800 dark:text-emerald-100']">{{ props.viewModel.metrics.done }}</strong>
              <span :class="['text-[11px] text-emerald-700 dark:text-emerald-200']">완료</span>
            </div>
            <div :class="['rounded-lg border border-red-200 bg-red-50 px-3 py-2 dark:border-red-500/30 dark:bg-red-500/10']">
              <strong :class="['block text-xl leading-none text-red-800 dark:text-red-100']">{{ props.viewModel.metrics.blocked }}</strong>
              <span :class="['text-[11px] text-red-700 dark:text-red-200']">막힘</span>
            </div>
          </div>

          <div
            :class="[
              'rounded-lg border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900',
            ]"
          >
            <div :class="['flex items-center justify-between gap-3 text-xs text-neutral-500 dark:text-neutral-400']">
              <span>Project health</span>
              <strong :class="['rounded-full bg-white px-2 py-1 text-neutral-800 dark:bg-neutral-950 dark:text-neutral-100']">
                {{ props.viewModel.metrics.healthLabel }}
              </strong>
            </div>
            <div :class="['mt-3 flex h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800']">
              <div
                v-for="segment in props.viewModel.metrics.statusSegments"
                :key="segment.status"
                :title="`${segment.label}: ${segment.count}`"
                :class="['h-full', segment.class]"
                :style="{ width: `${segment.percent}%` }"
              />
            </div>
          </div>
        </div>
      </section>

      <section :class="['min-h-0 min-w-0 grid grid-cols-[minmax(0,1fr)_390px] max-xl:grid-cols-1']">
        <div :class="['min-h-0 min-w-0 grid grid-rows-[auto_minmax(0,1fr)]']">
          <div
            :class="[
              'flex items-center justify-between gap-3 border-b px-5 py-3',
              'border-neutral-200 bg-white/90 dark:border-neutral-800 dark:bg-neutral-950/80',
              'max-md:flex-col max-md:items-stretch',
            ]"
          >
            <label :class="['relative min-w-64 max-w-md flex-1 max-md:min-w-0']">
              <span :class="['i-solar:magnifer-bold absolute left-3 top-1/2 z-1 size-4 text-neutral-400 -translate-y-1/2']" />
              <Input
                v-model="query"
                variant="primary-dimmed"
                placeholder="일감, 프로젝트, 브랜치 검색"
                :class="['pl-9']"
              />
            </label>
            <div :class="['flex shrink-0 items-center gap-2']">
              <Select
                v-model="groupBy"
                :options="groupOptions"
                shape="rounded"
                variant="blurry"
                content-width="180px"
              >
                <template #value="{ option }">
                  <span :class="['flex min-w-0 items-center gap-2']">
                    <span
                      v-if="option?.icon"
                      :class="['size-4 shrink-0', option.icon]"
                    />
                    <span :class="['truncate']">{{ option?.label ?? '그룹' }}</span>
                  </span>
                </template>
                <template #option="{ option }">
                  <span :class="['flex min-w-0 items-center gap-2']">
                    <span
                      v-if="option.icon"
                      :class="['size-4 shrink-0', option.icon]"
                    />
                    <span :class="['truncate']">{{ option.label }}</span>
                  </span>
                </template>
              </Select>
              <span :class="['hidden text-xs text-neutral-500 dark:text-neutral-400 md:inline']">
                {{ props.viewModel.visibleCards.length }} shown
              </span>
            </div>
          </div>

          <ProjectDashboardBoard
            :groups="props.viewModel.groups"
            :selected-work-item-id="props.selectedWorkItemId"
            :visible-count="props.viewModel.visibleCards.length"
            :can-create="canCreateWorkItem"
            :busy="props.isBusy"
            @create="emit('create')"
            @select="emit('selectWorkItem', $event)"
            @start="emit('startWorkItem', $event)"
            @edit="emit('editWorkItem', $event)"
          />
        </div>

        <ProjectWorkItemDetail
          :card="props.viewModel.selectedCard"
          :focus-card="props.viewModel.focusCard"
          :next-card="props.viewModel.nextCard"
          :can-create="canCreateWorkItem"
          :busy="props.isBusy"
          @create="emit('create')"
          @start="emit('startWorkItem', $event)"
          @edit="emit('editWorkItem', $event)"
          @delete="emit('deleteWorkItem', $event)"
          @select="emit('selectWorkItem', $event)"
        />
      </section>

      <div
        v-if="props.statusMessage || props.errorMessage"
        :class="['pointer-events-none fixed bottom-4 left-1/2 z-40 w-[min(560px,calc(100vw-2rem))] -translate-x-1/2']"
      >
        <div
          v-if="props.statusMessage"
          :class="[
            'rounded-lg border px-4 py-3 text-sm shadow-xl',
            'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-100',
          ]"
        >
          {{ props.statusMessage }}
        </div>
        <div
          v-else-if="props.errorMessage"
          :class="[
            'rounded-lg border px-4 py-3 text-sm shadow-xl',
            'border-red-200 bg-red-50 text-red-800 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-100',
          ]"
        >
          {{ props.errorMessage }}
        </div>
      </div>
    </main>
  </div>
</template>
