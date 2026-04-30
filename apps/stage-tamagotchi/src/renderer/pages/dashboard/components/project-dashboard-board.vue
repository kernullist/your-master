<script setup lang="ts">
import type { ProjectDashboardGroup } from '../utils/project-dashboard-model'

import { Button } from '@proj-airi/ui'

import ProjectDashboardColumn from './project-dashboard-column.vue'

const props = defineProps<{
  groups: ProjectDashboardGroup[]
  selectedWorkItemId: string | null
  visibleCount: number
  canCreate?: boolean
  busy?: boolean
}>()

const emit = defineEmits<{
  create: []
  select: [id: string]
  start: [id: string]
  edit: [id: string]
}>()
</script>

<template>
  <section :class="['min-w-0']">
    <div
      v-if="props.visibleCount > 0"
      :class="[
        'flex min-h-full gap-3 overflow-x-auto px-4 py-4',
        'scrollbar-thin scrollbar-track-transparent scrollbar-thumb-neutral-300 dark:scrollbar-thumb-neutral-700',
      ]"
    >
      <ProjectDashboardColumn
        v-for="group in props.groups"
        :key="group.id"
        :group="group"
        :selected-work-item-id="props.selectedWorkItemId"
        :busy="props.busy"
        @select="emit('select', $event)"
        @start="emit('start', $event)"
        @edit="emit('edit', $event)"
      />
    </div>

    <div
      v-else
      :class="[
        'grid min-h-[58vh] place-items-center p-6',
      ]"
    >
      <div
        :class="[
          'w-full max-w-md rounded-lg border border-dashed p-6 text-center',
          'border-neutral-300 bg-white/70 dark:border-neutral-700 dark:bg-neutral-900/40',
        ]"
      >
        <div :class="['mx-auto grid size-11 place-items-center rounded-lg bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-300']">
          <span :class="['i-solar:kanban-bold-duotone size-6']" />
        </div>
        <h2 :class="['mt-4 text-base font-semibold text-neutral-950 dark:text-neutral-50']">
          표시할 일감이 없어
        </h2>
        <p :class="['mt-2 text-sm leading-6 text-neutral-500 dark:text-neutral-400']">
          검색어와 필터를 조정하거나 새 일감을 추가해.
        </p>
        <div :class="['mt-4 flex justify-center']">
          <Button
            icon="i-solar:add-circle-bold"
            label="새 일감"
            :disabled="!props.canCreate || props.busy"
            @click="emit('create')"
          />
        </div>
      </div>
    </div>
  </section>
</template>
