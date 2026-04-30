<script setup lang="ts">
import type { WorkItemStatus } from '@proj-airi/stage-projects'

import { computed } from 'vue'

import { projectDashboardStatusMeta } from '../utils/project-dashboard-model'

const props = defineProps<{
  status: WorkItemStatus
  compact?: boolean
}>()

const meta = computed(() => projectDashboardStatusMeta[props.status])
</script>

<template>
  <span
    :class="[
      'inline-flex shrink-0 items-center gap-1 rounded-full border font-medium leading-none',
      props.compact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-xs',
      ...meta.badgeClass,
    ]"
  >
    <span :class="['size-1.5 rounded-full', meta.dotClass]" />
    {{ meta.label }}
  </span>
</template>
