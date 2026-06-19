import type { DisplayModel } from '../display-models'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { refManualReset, useEventListener } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, watch } from 'vue'

import { DisplayModelFormat, useDisplayModelsStore } from '../display-models'

export type StageModelRenderer = 'live2d' | 'vrm' | 'image' | 'godot' | 'disabled' | undefined
type BuiltInStageModelRenderer = Exclude<StageModelRenderer, 'godot'>

/** Object URL minted for the currently active file-backed display model. */
interface StageObjectUrlCacheEntry {
  modelId: string
  url: string
}

/**
 * Decides whether the cached object URL can be reused for a file-backed model.
 *
 * Use when:
 * - updateStageModel() re-resolves a file model and wants to avoid minting a
 *   fresh `blob:` URL (which would change stageModelSelectedUrl and force the
 *   renderer to reload, flashing the host "Loading..." overlay).
 *
 * Expects:
 * - `currentUrl` is the URL currently assigned to the stage; reuse is only safe
 *   while it still equals the cached URL, because switching models revokes it.
 *
 * Returns:
 * - `true` when the same model is still active and its object URL is live.
 */
export function shouldReuseStageObjectUrl(
  cache: StageObjectUrlCacheEntry | undefined,
  modelId: string,
  currentUrl: string | undefined,
): boolean {
  return !!cache && cache.modelId === modelId && cache.url === currentUrl
}

export const useSettingsStageModel = defineStore('settings-stage-model', () => {
  const displayModelsStore = useDisplayModelsStore()
  let stageModelUpdateSequence = 0
  // Tracks the object URL minted for the active file-backed model so repeated
  // updateStageModel() runs for the SAME model reuse it instead of minting a
  // new blob: URL each time (see shouldReuseStageObjectUrl).
  let stageObjectUrlCache: StageObjectUrlCacheEntry | undefined
  const stageModelStorageKey = 'settings/stage/model'

  const stageModelSelectedState = useLocalStorageManualReset<string>(stageModelStorageKey, 'preset-live2d-mao')
  const stageModelSelected = computed<string>({
    get: () => stageModelSelectedState.value,
    set: (value) => {
      stageModelSelectedState.value = value
    },
  })
  const stageModelSelectedDisplayModel = refManualReset<DisplayModel | undefined>(undefined)
  const stageModelSelectedUrl = refManualReset<string | undefined>(undefined)
  const stageModelRenderer = refManualReset<StageModelRenderer>(undefined)
  const stageModelBuiltInRenderer = refManualReset<BuiltInStageModelRenderer>(undefined)

  const stageViewControlsEnabled = refManualReset<boolean>(false)

  function revokeStageModelUrl(url?: string) {
    if (url?.startsWith('blob:'))
      URL.revokeObjectURL(url)
  }

  function replaceStageModelUrl(nextUrl?: string) {
    if (stageModelSelectedUrl.value === nextUrl)
      return

    revokeStageModelUrl(stageModelSelectedUrl.value)
    stageModelSelectedUrl.value = nextUrl
  }

  function resolveBuiltInStageModelRenderer(model?: DisplayModel): BuiltInStageModelRenderer {
    if (!model) {
      return 'disabled'
    }

    switch (model.format) {
      case DisplayModelFormat.Live2dZip:
        return 'live2d'
      case DisplayModelFormat.VRM:
        return 'vrm'
      case DisplayModelFormat.Image:
        return 'image'
      default:
        return 'disabled'
    }
  }

  async function updateStageModel() {
    const requestId = ++stageModelUpdateSequence
    const selectedModelId = stageModelSelectedState.value

    if (!selectedModelId) {
      replaceStageModelUrl(undefined)
      stageModelSelectedDisplayModel.value = undefined
      stageModelBuiltInRenderer.value = 'disabled'
      if (stageModelRenderer.value !== 'godot')
        stageModelRenderer.value = 'disabled'
      return
    }

    const model = await displayModelsStore.getDisplayModel(selectedModelId)
    if (requestId !== stageModelUpdateSequence)
      return

    if (!model) {
      replaceStageModelUrl(undefined)
      stageModelSelectedDisplayModel.value = undefined
      stageModelBuiltInRenderer.value = 'disabled'
      if (stageModelRenderer.value !== 'godot')
        stageModelRenderer.value = 'disabled'
      return
    }

    const builtInRenderer = resolveBuiltInStageModelRenderer(model)
    stageModelBuiltInRenderer.value = builtInRenderer
    if (stageModelRenderer.value !== 'godot')
      stageModelRenderer.value = builtInRenderer

    if (model.type === 'file') {
      // Same file model still active: reuse the existing object URL so the
      // renderer is not forced to reload (which flashes the Loading overlay).
      if (shouldReuseStageObjectUrl(stageObjectUrlCache, model.id, stageModelSelectedUrl.value)) {
        stageModelSelectedDisplayModel.value = model
        return
      }

      const nextUrl = URL.createObjectURL(model.file)
      if (requestId !== stageModelUpdateSequence) {
        URL.revokeObjectURL(nextUrl)
        return
      }

      stageObjectUrlCache = { modelId: model.id, url: nextUrl }
      replaceStageModelUrl(nextUrl)
    }
    else {
      replaceStageModelUrl(model.url)
    }

    stageModelSelectedDisplayModel.value = model
  }

  function setStageModelRenderer(renderer: StageModelRenderer) {
    stageModelRenderer.value = renderer
  }

  function restoreBuiltInStageModelRenderer() {
    stageModelRenderer.value = stageModelBuiltInRenderer.value ?? 'disabled'
  }

  async function initializeStageModel() {
    await updateStageModel()
  }

  useEventListener('unload', () => {
    revokeStageModelUrl(stageModelSelectedUrl.value)
  })

  watch(stageModelSelectedState, (_newValue, _oldValue) => {
    void updateStageModel()
  })

  async function resetState() {
    revokeStageModelUrl(stageModelSelectedUrl.value)
    // Drop the object URL cache so a post-reset reload mints a fresh URL
    // instead of reusing one that was just revoked.
    stageObjectUrlCache = undefined

    stageModelSelectedState.reset()
    stageModelSelectedDisplayModel.reset()
    stageModelSelectedUrl.reset()
    stageModelRenderer.reset()
    stageModelBuiltInRenderer.reset()
    stageViewControlsEnabled.reset()

    await updateStageModel()
  }

  return {
    stageModelRenderer,
    stageModelSelected,
    stageModelSelectedUrl,
    stageModelSelectedDisplayModel,
    stageViewControlsEnabled,

    initializeStageModel,
    restoreBuiltInStageModelRenderer,
    setStageModelRenderer,
    updateStageModel,
    resetState,
  }
})
