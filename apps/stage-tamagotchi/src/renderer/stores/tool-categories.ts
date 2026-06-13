/**
 * Tool category definitions for capability scoping. Pure (no store/vue) so the
 * selection logic is unit-testable.
 *
 * The assistant exposes a lot of tools at once, which strains weak local
 * models (selection accuracy + prefill tokens). Grouping tools into toggleable
 * categories lets the user (via the assistant's own scoping tools) narrow what
 * is offered. Defaults keep the assistant-relevant set on; only `project`
 * (git-bound work-item management) is off by default as it is not a personal
 * assistant feature.
 */

export type ToolCategoryId
  = | 'files'
    | 'system'
    | 'productivity'
    | 'memory'
    | 'math'
    | 'web'
    | 'creative'
    | 'project'

export interface ToolCategoryMeta {
  id: ToolCategoryId
  /** Short human label shown when listing categories. */
  label: string
  /** One-line description of what the category covers. */
  description: string
  /** Whether the category is offered to the model when the user has not chosen. */
  defaultEnabled: boolean
}

export const TOOL_CATEGORIES: ToolCategoryMeta[] = [
  { id: 'files', label: 'Files', description: 'Read, list, search, write and edit files', defaultEnabled: true },
  { id: 'system', label: 'System', description: 'Run commands, clipboard, screenshot, system info, window control', defaultEnabled: true },
  { id: 'productivity', label: 'Productivity', description: 'To-dos, reminders, timers, routines, daily briefing', defaultEnabled: true },
  { id: 'memory', label: 'Memory', description: 'Remember and recall facts about the user', defaultEnabled: true },
  { id: 'math', label: 'Math', description: 'Calculator and unit conversion', defaultEnabled: true },
  { id: 'web', label: 'Web', description: 'Weather and other web lookups', defaultEnabled: true },
  { id: 'creative', label: 'Creative', description: 'Image generation and on-screen widgets', defaultEnabled: true },
  { id: 'project', label: 'Project management', description: 'Git-bound project boards and work items', defaultEnabled: false },
]

const VALID_IDS = new Set<string>(TOOL_CATEGORIES.map(category => category.id))

/** Whether a string is a known category id. */
export function isToolCategoryId(value: string): value is ToolCategoryId {
  return VALID_IDS.has(value)
}

/** The default enabled map, derived from each category's `defaultEnabled`. */
export function defaultEnabledMap(): Record<ToolCategoryId, boolean> {
  const map = {} as Record<ToolCategoryId, boolean>
  for (const category of TOOL_CATEGORIES) {
    map[category.id] = category.defaultEnabled
  }
  return map
}

/**
 * Whether a category is enabled, falling back to its default when the stored
 * map has no entry for it (e.g. a category added after the user's map was
 * saved).
 */
export function isCategoryEnabled(enabled: Partial<Record<ToolCategoryId, boolean>>, id: ToolCategoryId): boolean {
  const stored = enabled[id]
  if (typeof stored === 'boolean') {
    return stored
  }
  return TOOL_CATEGORIES.find(category => category.id === id)?.defaultEnabled ?? false
}

/** Ordered list of enabled category ids for the given map. */
export function resolveEnabledCategoryIds(enabled: Partial<Record<ToolCategoryId, boolean>>): ToolCategoryId[] {
  return TOOL_CATEGORIES.filter(category => isCategoryEnabled(enabled, category.id)).map(category => category.id)
}
