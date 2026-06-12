import { useLocalStorageManualReset, useVersionedLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'

export const useSettingsLive2d = defineStore('settings-live2d', () => {
  const live2dDisableFocus = useLocalStorageManualReset<boolean>('settings/live2d/disable-focus', false)
  const live2dIdleAnimationEnabled = useLocalStorageManualReset<boolean>('settings/live2d/idle-animation-enabled', true)
  // NOTICE:
  // Version bumped 2.0.0 -> 2.1.0 to flip the default to `true` for existing
  // installs as well: the versioned storage resets a stored value whenever its
  // persisted version differs from `defaultVersion` (see
  // `stage-shared/composables/use-versioned-local-storage`). Natural blinking
  // makes the character feel alive and was previously off by default.
  const live2dAutoBlinkEnabled = useVersionedLocalStorageManualReset<boolean>('settings/live2d/auto-blink-enabled', true, {
    defaultVersion: '2.1.0',
    satisfiesVersionBy(beforeVersion, afterVersion) {
      if (beforeVersion === afterVersion) {
        return true
      }

      return false
    },
  })
  const live2dForceAutoBlinkEnabled = useVersionedLocalStorageManualReset<boolean>('settings/live2d/force-auto-blink-enabled', true, {
    defaultVersion: '2.0.0',
    satisfiesVersionBy(beforeVersion, afterVersion) {
      if (beforeVersion === afterVersion) {
        return true
      }

      return false
    },
  })
  // NOTICE:
  // Converted from plain to versioned storage to enable emotion-driven
  // expressions by default: without this, the `<|ACT ...|>` emotion tokens the
  // LLM emits never reach the character's face. Old installs persisted a raw
  // boolean under this key; the versioned reader treats that shape as
  // corrupted (no `version` field) and falls back to the new default, which
  // is exactly the migration we want.
  const live2dExpressionEnabled = useVersionedLocalStorageManualReset<boolean>('settings/live2d/expression-enabled', true, {
    defaultVersion: '2.1.0',
    satisfiesVersionBy(beforeVersion, afterVersion) {
      if (beforeVersion === afterVersion) {
        return true
      }

      return false
    },
  })
  const live2dShadowEnabled = useLocalStorageManualReset<boolean>('settings/live2d/shadow-enabled', true)
  const live2dMaxFps = useLocalStorageManualReset<number>('settings/live2d/max-fps', 0)
  const live2dRenderScale = useLocalStorageManualReset<number>('settings/live2d/render-scale', 2)

  function resetState() {
    live2dDisableFocus.reset()
    live2dIdleAnimationEnabled.reset()
    live2dAutoBlinkEnabled.reset()
    live2dForceAutoBlinkEnabled.reset()
    live2dExpressionEnabled.reset()
    live2dShadowEnabled.reset()
    live2dMaxFps.reset()
    live2dRenderScale.reset()
  }

  return {
    live2dDisableFocus,
    live2dIdleAnimationEnabled,
    live2dAutoBlinkEnabled,
    live2dForceAutoBlinkEnabled,
    live2dExpressionEnabled,
    live2dShadowEnabled,
    live2dMaxFps,
    live2dRenderScale,
    resetState,
  }
})
