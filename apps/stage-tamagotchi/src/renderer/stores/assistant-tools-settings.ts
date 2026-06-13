import type { ToolCategoryId } from './tool-categories'

import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'

import { defaultEnabledMap, isCategoryEnabled, resolveEnabledCategoryIds } from './tool-categories'

/**
 * Persisted on/off state for tool categories (capability scoping). Lets the
 * user narrow which tool groups the assistant is offered, easing weak local
 * models. Defaults from each category's `defaultEnabled`.
 */
export const useAssistantToolsSettings = defineStore('assistant-tools-settings', () => {
  const enabled = useLocalStorage<Partial<Record<ToolCategoryId, boolean>>>('assistant/tool-categories', defaultEnabledMap())

  function isEnabled(id: ToolCategoryId): boolean {
    return isCategoryEnabled(enabled.value, id)
  }

  function setEnabled(id: ToolCategoryId, value: boolean) {
    enabled.value = { ...enabled.value, [id]: value }
  }

  function enabledCategoryIds(): ToolCategoryId[] {
    return resolveEnabledCategoryIds(enabled.value)
  }

  return {
    enabled,
    isEnabled,
    setEnabled,
    enabledCategoryIds,
  }
})
