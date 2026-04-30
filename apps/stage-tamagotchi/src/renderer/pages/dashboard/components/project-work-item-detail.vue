<script setup lang="ts">
import type { ProjectDashboardCard } from '../utils/project-dashboard-model'

import { Button, DoubleCheckButton } from '@proj-airi/ui'
import { computed } from 'vue'

import ProjectStatusBadge from './project-status-badge.vue'

const props = defineProps<{
  card?: ProjectDashboardCard
  focusCard?: ProjectDashboardCard
  nextCard?: ProjectDashboardCard
  canCreate?: boolean
  busy?: boolean
}>()

const emit = defineEmits<{
  create: []
  start: [id: string]
  edit: [id: string]
  delete: [id: string]
  select: [id: string]
}>()

const changedFiles = computed(() => props.card?.latestRun?.changedFiles.slice(0, 5) ?? [])
const hiddenChangedFileCount = computed(() => Math.max(0, (props.card?.latestRun?.changedFiles.length ?? 0) - changedFiles.value.length))
</script>

<template>
  <aside
    :class="[
      'min-h-0 border-l bg-white/75 dark:bg-neutral-950/50',
      'border-neutral-200 dark:border-neutral-800',
    ]"
  >
    <div
      v-if="props.card"
      :class="['sticky top-0 grid max-h-dvh gap-4 overflow-y-auto p-4']"
    >
      <div :class="['flex items-start justify-between gap-3']">
        <div :class="['min-w-0']">
          <div :class="['text-xs font-semibold text-neutral-500 dark:text-neutral-400']">
            {{ props.card.item.identifier }}
          </div>
          <h2 :class="['mt-1 text-xl font-semibold leading-7 text-neutral-950 dark:text-neutral-50']">
            {{ props.card.item.title }}
          </h2>
        </div>
        <ProjectStatusBadge :status="props.card.item.status" />
      </div>

      <div :class="['flex flex-wrap gap-2']">
        <Button
          v-if="props.card.item.status === 'todo'"
          icon="i-solar:play-circle-bold"
          label="시작"
          size="sm"
          :disabled="props.busy"
          @click="emit('start', props.card.item.id)"
        />
        <Button
          icon="i-solar:pen-bold"
          label="편집"
          size="sm"
          variant="secondary"
          :disabled="props.busy"
          @click="emit('edit', props.card.item.id)"
        />
        <DoubleCheckButton
          size="sm"
          variant="danger"
          :disabled="props.busy"
          @confirm="props.card && emit('delete', props.card.item.id)"
        >
          삭제
          <template #confirm>
            삭제 확인
          </template>
          <template #cancel>
            취소
          </template>
        </DoubleCheckButton>
      </div>

      <section :class="['grid gap-2']">
        <h3 :class="['text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400']">
          Goal
        </h3>
        <p :class="['m-0 rounded-lg bg-neutral-100/70 p-3 text-sm leading-6 text-neutral-700 dark:bg-neutral-900 dark:text-neutral-200']">
          {{ props.card.item.goal || '목표가 아직 비어 있어.' }}
        </p>
      </section>

      <section :class="['grid gap-2']">
        <h3 :class="['text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400']">
          Acceptance
        </h3>
        <ul
          v-if="props.card.item.acceptanceCriteria.length"
          :class="['grid gap-2']"
        >
          <li
            v-for="criterion in props.card.item.acceptanceCriteria"
            :key="criterion"
            :class="[
              'flex gap-2 rounded-lg border px-3 py-2 text-sm leading-5',
              'border-neutral-200 bg-white text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200',
            ]"
          >
            <span :class="['i-solar:check-circle-bold-duotone mt-0.5 size-4 shrink-0 text-emerald-500']" />
            <span>{{ criterion }}</span>
          </li>
        </ul>
        <div
          v-else
          :class="['rounded-lg border border-dashed border-neutral-300 px-3 py-4 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400']"
        >
          완료 조건이 아직 없어.
        </div>
      </section>

      <section
        v-if="props.card.latestRun"
        :class="['grid gap-2']"
      >
        <h3 :class="['text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400']">
          Latest Run
        </h3>
        <div
          :class="[
            'grid gap-3 rounded-lg border p-3',
            'border-neutral-200 bg-neutral-50/80 dark:border-neutral-800 dark:bg-neutral-900/70',
          ]"
        >
          <div :class="['flex flex-wrap gap-2 text-xs']">
            <span :class="['rounded-full bg-neutral-200 px-2 py-1 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200']">
              {{ props.card.latestRun.lifecycleStatus ?? props.card.latestRun.status }}
            </span>
            <span
              v-if="props.card.latestRun.branchName"
              :class="['rounded-full bg-sky-100 px-2 py-1 text-sky-700 dark:bg-sky-500/15 dark:text-sky-200']"
            >
              {{ props.card.latestRun.branchName }}
            </span>
            <span
              v-if="props.card.latestRun.worktreeState && props.card.latestRun.worktreeState !== 'none'"
              :class="['rounded-full bg-indigo-100 px-2 py-1 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-200']"
            >
              {{ props.card.latestRun.worktreeState }}
            </span>
          </div>

          <p
            v-if="props.card.latestRun.planSummary"
            :class="['m-0 text-sm leading-6 text-neutral-700 dark:text-neutral-200']"
          >
            {{ props.card.latestRun.planSummary }}
          </p>

          <div
            v-if="changedFiles.length"
            :class="['grid gap-1 text-xs text-neutral-500 dark:text-neutral-400']"
          >
            <div :class="['font-semibold text-neutral-600 dark:text-neutral-300']">
              Changed files
            </div>
            <code
              v-for="file in changedFiles"
              :key="file"
              :class="['block truncate rounded bg-white px-2 py-1 dark:bg-neutral-950']"
            >
              {{ file }}
            </code>
            <span v-if="hiddenChangedFileCount > 0">
              +{{ hiddenChangedFileCount }} more
            </span>
          </div>

          <p
            v-if="props.card.latestRun.testSummary"
            :class="['m-0 rounded-md bg-emerald-50 px-2 py-1.5 text-xs text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200']"
          >
            {{ props.card.latestRun.testSummary }}
          </p>
          <p
            v-if="props.card.latestRun.error"
            :class="['m-0 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-200']"
          >
            {{ props.card.latestRun.error }}
          </p>
        </div>
      </section>

      <section
        v-if="props.card.latestComment"
        :class="['grid gap-2']"
      >
        <h3 :class="['text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400']">
          Latest Note
        </h3>
        <div
          :class="[
            'rounded-lg border-l-3 px-3 py-2 text-sm leading-6',
            'border-primary-400 bg-primary-50 text-neutral-700 dark:bg-primary-500/10 dark:text-neutral-200',
          ]"
        >
          <div :class="['mb-1 text-xs font-semibold text-neutral-500 dark:text-neutral-400']">
            {{ props.card.latestComment.actorType }} · {{ props.card.latestComment.kind }}
          </div>
          {{ props.card.latestComment.content }}
        </div>
      </section>
    </div>

    <div
      v-else
      :class="['grid min-h-dvh content-start gap-4 p-4']"
    >
      <div
        :class="[
          'rounded-lg border border-dashed p-5 text-center',
          'border-neutral-300 bg-white/70 dark:border-neutral-700 dark:bg-neutral-900/40',
        ]"
      >
        <div :class="['mx-auto grid size-10 place-items-center rounded-lg bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-300']">
          <span :class="['i-solar:document-text-bold-duotone size-5']" />
        </div>
        <h2 :class="['mt-3 text-base font-semibold text-neutral-950 dark:text-neutral-50']">
          일감을 선택해줘
        </h2>
        <p :class="['mt-2 text-sm leading-6 text-neutral-500 dark:text-neutral-400']">
          카드의 목표, 완료 조건, 실행 기록을 여기에서 빠르게 확인할 수 있어.
        </p>
        <Button
          icon="i-solar:add-circle-bold"
          label="새 일감"
          size="sm"
          :disabled="!props.canCreate || props.busy"
          @click="emit('create')"
        />
      </div>

      <button
        v-if="props.focusCard"
        type="button"
        :class="[
          'grid gap-1 rounded-lg border p-3 text-left transition',
          'border-red-200 bg-red-50 text-red-900 hover:bg-red-100 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100 dark:hover:bg-red-500/15',
        ]"
        @click="emit('select', props.focusCard.item.id)"
      >
        <span :class="['text-xs font-semibold uppercase tracking-wide']">Focus</span>
        <strong :class="['line-clamp-2 text-sm']">{{ props.focusCard.item.identifier }} · {{ props.focusCard.item.title }}</strong>
      </button>

      <button
        v-if="props.nextCard"
        type="button"
        :class="[
          'grid gap-1 rounded-lg border p-3 text-left transition',
          'border-sky-200 bg-sky-50 text-sky-900 hover:bg-sky-100 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100 dark:hover:bg-sky-500/15',
        ]"
        @click="emit('select', props.nextCard.item.id)"
      >
        <span :class="['text-xs font-semibold uppercase tracking-wide']">Next up</span>
        <strong :class="['line-clamp-2 text-sm']">{{ props.nextCard.item.identifier }} · {{ props.nextCard.item.title }}</strong>
      </button>
    </div>
  </aside>
</template>
