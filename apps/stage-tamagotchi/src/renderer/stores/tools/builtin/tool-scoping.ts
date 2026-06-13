import type { Tool } from '@xsai/shared-chat'

import { tool } from '@xsai/tool'
import { z } from 'zod'

import { useAssistantToolsSettings } from '../../assistant-tools-settings'
import { isToolCategoryId, TOOL_CATEGORIES } from '../../tool-categories'

/**
 * Self-scoping tools: let the assistant report and adjust which tool
 * categories are active. Always offered (not gated by a category) so the user
 * can always re-enable a category that was turned off. Changes take effect on
 * the next message.
 */
const tools: Promise<Tool>[] = [
  tool({
    name: 'list_tool_categories',
    description: 'List your tool categories and whether each is currently enabled. Use when the user asks what you can do, or wants to turn capabilities on/off.',
    execute: async () => {
      const settings = useAssistantToolsSettings()
      return JSON.stringify(TOOL_CATEGORIES.map(category => ({
        id: category.id,
        label: category.label,
        description: category.description,
        enabled: settings.isEnabled(category.id),
      })))
    },
    parameters: z.object({}),
  }),
  tool({
    name: 'set_tool_category',
    description: 'Enable or disable a tool category (capability scoping). Use when the user asks you to turn a group of abilities on or off. Disabling a category removes its tools from your next responses.',
    execute: async ({ category, enabled }) => {
      if (!isToolCategoryId(category)) {
        const ids = TOOL_CATEGORIES.map(c => c.id).join(', ')
        return `Error: unknown category "${category}". Valid categories: ${ids}`
      }
      const settings = useAssistantToolsSettings()
      settings.setEnabled(category, enabled)
      return `OK: ${category} ${enabled ? 'enabled' : 'disabled'} (takes effect on the next message)`
    },
    parameters: z.object({
      category: z.string().describe('Category id: files, system, productivity, memory, math, web, creative, or project'),
      enabled: z.boolean().describe('true to enable, false to disable'),
    }),
  }),
]

export const toolScopingTools = async () => Promise.all(tools)
