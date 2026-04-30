<script setup lang="ts">
import type { ProjectDashboardGroup } from '../utils/project-dashboard-model'

import ProjectWorkItemCard from './project-work-item-card.vue'

const props = defineProps<{
  group: ProjectDashboardGroup
  selectedWorkItemId: string | null
  busy?: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
  start: [id: string]
  edit: [id: string]
}>()
</script>

<template>
  <section
    :class="[
      'flex min-h-[58vh] w-[min(22rem,82vw)] shrink-0 flex-col rounded-lg border',
      'border-neutral-200/80 bg-neutral-50/70 dark:border-neutral-800/80 dark:bg-neutral-950/30',
    ]"
  >
    <header
      :class="[
        'sticky top-0 z-1 flex items-center justify-between gap-3 rounded-t-lg border-b px-3 py-2',
        'border-neutral-200/70 bg-white/75 backdrop-blur dark:border-neutral-800/80 dark:bg-neutral-900/75',
      ]"
    >
      <div :class="['min-w-0 flex items-center gap-2']">
        <span
          :class="[
            'grid size-6 shrink-0 place-items-center rounded-md bg-white shadow-sm dark:bg-neutral-900',
          ]"
        >
          <span :class="['size-3.5', props.group.icon]" />
        </span>
        <div :class="['min-w-0']">
          <h2 :class="['truncate text-sm font-semibold text-neutral-800 dark:text-neutral-100']">
            {{ props.group.title }}
          </h2>
          <p
            v-if="props.group.subtitle"
            :class="['truncate text-[11px] text-neutral-500 dark:text-neutral-400']"
          >
            {{ props.group.subtitle }}
          </p>
        </div>
      </div>
      <span
        :class="[
          'inline-flex min-w-7 justify-center rounded-full px-2 py-1 text-xs font-semibold',
          'bg-neutral-200/80 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200',
        ]"
      >
        {{ props.group.cards.length }}
      </span>
    </header>

    <div :class="['grid gap-2 p-2']">
      <ProjectWorkItemCard
        v-for="card in props.group.cards"
        :key="card.item.id"
        :card="card"
        :selected="props.selectedWorkItemId === card.item.id"
        :busy="props.busy"
        @select="emit('select', $event)"
        @start="emit('start', $event)"
        @edit="emit('edit', $event)"
      />
      <div
        v-if="props.group.cards.length === 0"
        :class="[
          'rounded-lg border border-dashed px-3 py-8 text-center text-xs',
          'border-neutral-300 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400',
        ]"
      >
        이 컬럼에는 일감이 없어.
      </div>
    </div>
  </section>
</template>
