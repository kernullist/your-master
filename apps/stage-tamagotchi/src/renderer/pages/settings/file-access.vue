<script setup lang="ts">
import { errorMessageFrom } from '@moeru/std'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { Button, FieldInput } from '@proj-airi/ui'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import {
  electronFilesAddFreeAccessPath,
  electronFilesGetFreeAccessPaths,
  electronFilesRemoveFreeAccessPath,
} from '../../../shared/eventa'

const { t } = useI18n()

const getFreeAccessPaths = useElectronEventaInvoke(electronFilesGetFreeAccessPaths)
const addFreeAccessPath = useElectronEventaInvoke(electronFilesAddFreeAccessPath)
const removeFreeAccessPath = useElectronEventaInvoke(electronFilesRemoveFreeAccessPath)

const isBusy = ref(false)
const paths = ref<string[]>([])
const manualPath = ref('')
const statusMessage = ref('')
const errorMessage = ref('')

async function refreshPaths() {
  const result = await getFreeAccessPaths()
  paths.value = result.paths ?? []
}

async function handlePickFolder() {
  isBusy.value = true
  errorMessage.value = ''
  statusMessage.value = ''

  try {
    const result = await addFreeAccessPath({})
    paths.value = result.paths ?? []
    if (!result.ok) {
      if (result.message && !result.message.includes('canceled')) {
        errorMessage.value = result.message
      }
      return
    }
    statusMessage.value = t('settings.pages.file-access.messages.added', { path: result.path ?? '' })
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? t('settings.pages.file-access.messages.add-failed')
  }
  finally {
    isBusy.value = false
  }
}

async function handleAddManualPath() {
  const path = manualPath.value.trim()
  if (!path) {
    errorMessage.value = t('settings.pages.file-access.messages.path-required')
    return
  }

  isBusy.value = true
  errorMessage.value = ''
  statusMessage.value = ''

  try {
    const result = await addFreeAccessPath({ path })
    paths.value = result.paths ?? []
    if (!result.ok) {
      errorMessage.value = result.message ?? t('settings.pages.file-access.messages.add-failed')
      return
    }
    manualPath.value = ''
    statusMessage.value = result.message?.includes('already')
      ? t('settings.pages.file-access.messages.already-covered', { path: result.path ?? path })
      : t('settings.pages.file-access.messages.added', { path: result.path ?? path })
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? t('settings.pages.file-access.messages.add-failed')
  }
  finally {
    isBusy.value = false
  }
}

async function handleRemovePath(path: string) {
  isBusy.value = true
  errorMessage.value = ''
  statusMessage.value = ''

  try {
    const result = await removeFreeAccessPath({ path })
    paths.value = result.paths ?? []
    if (!result.ok) {
      errorMessage.value = result.message ?? t('settings.pages.file-access.messages.remove-failed')
      return
    }
    statusMessage.value = t('settings.pages.file-access.messages.removed', { path })
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? t('settings.pages.file-access.messages.remove-failed')
  }
  finally {
    isBusy.value = false
  }
}

onMounted(async () => {
  try {
    await refreshPaths()
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? t('settings.pages.file-access.messages.load-failed')
  }
})
</script>

<template>
  <div
    :class="[
      'pb-12',
      'flex flex-col gap-5',
    ]"
  >
    <section
      :class="[
        'rounded-lg border p-4 md:p-5',
        'border-neutral-200/70 bg-white/75 dark:border-neutral-700/70 dark:bg-neutral-900/40',
        'flex flex-col gap-4',
      ]"
    >
      <div :class="['flex flex-col gap-1']">
        <h2 :class="['text-lg font-medium']">
          {{ t('settings.pages.file-access.sections.free-paths.title') }}
        </h2>
        <p :class="['text-sm text-neutral-600 dark:text-neutral-400']">
          {{ t('settings.pages.file-access.sections.free-paths.description') }}
        </p>
      </div>

      <div
        :class="[
          'rounded-md border px-3 py-2 text-sm',
          'border-amber-200/80 bg-amber-50/80 text-amber-900',
          'dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100',
        ]"
      >
        {{ t('settings.pages.file-access.sections.free-paths.warning') }}
      </div>

      <div :class="['flex flex-col gap-3 sm:flex-row sm:items-end']">
        <div :class="['min-w-0 flex-1']">
          <FieldInput
            v-model="manualPath"
            :label="t('settings.pages.file-access.sections.free-paths.manual-label')"
            :description="t('settings.pages.file-access.sections.free-paths.manual-description')"
            :placeholder="t('settings.pages.file-access.sections.free-paths.manual-placeholder')"
            @keydown.enter.prevent="handleAddManualPath"
          />
        </div>
        <div :class="['flex flex-wrap gap-2']">
          <Button variant="secondary" :disabled="isBusy" @click="handleAddManualPath">
            {{ t('settings.pages.file-access.actions.add-path') }}
          </Button>
          <Button :disabled="isBusy" @click="handlePickFolder">
            {{ t('settings.pages.file-access.actions.pick-folder') }}
          </Button>
        </div>
      </div>

      <div
        v-if="paths.length === 0"
        :class="[
          'rounded-md border border-dashed px-3 py-6 text-center text-sm',
          'border-neutral-300 text-neutral-500',
          'dark:border-neutral-700 dark:text-neutral-400',
        ]"
      >
        {{ t('settings.pages.file-access.sections.free-paths.empty') }}
      </div>

      <ul
        v-else
        :class="['flex flex-col gap-2']"
      >
        <li
          v-for="path in paths"
          :key="path"
          :class="[
            'flex items-center gap-3 rounded-md border px-3 py-2',
            'border-neutral-200/80 bg-neutral-50/80',
            'dark:border-neutral-700/80 dark:bg-neutral-950/40',
          ]"
        >
          <div
            :class="[
              'i-solar:folder-with-files-bold-duotone shrink-0 text-lg',
              'text-primary-600 dark:text-primary-300',
            ]"
          />
          <div :class="['min-w-0 flex-1 break-all font-mono text-sm']">
            {{ path }}
          </div>
          <Button
            variant="secondary"
            size="sm"
            :disabled="isBusy"
            @click="handleRemovePath(path)"
          >
            {{ t('settings.pages.file-access.actions.remove') }}
          </Button>
        </li>
      </ul>
    </section>

    <div
      v-if="statusMessage"
      :class="[
        'rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2',
        'text-sm text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200',
      ]"
    >
      {{ statusMessage }}
    </div>
    <div
      v-if="errorMessage"
      :class="[
        'rounded-md border border-red-200 bg-red-50 px-3 py-2',
        'text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300',
      ]"
    >
      {{ errorMessage }}
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.file-access.title
  subtitleKey: settings.title
  descriptionKey: settings.pages.file-access.description
  icon: i-solar:folder-path-connect-bold-duotone
  settingsEntry: true
  order: 8
  stageTransition:
    name: slide
    pageSpecificAvailable: true
</route>
