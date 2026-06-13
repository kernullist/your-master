import { describe, expect, it } from 'vitest'

import {
  defaultEnabledMap,
  isCategoryEnabled,
  isToolCategoryId,
  resolveEnabledCategoryIds,
  TOOL_CATEGORIES,
} from './tool-categories'

describe('isToolCategoryId', () => {
  it('recognizes known ids and rejects others', () => {
    expect(isToolCategoryId('files')).toBe(true)
    expect(isToolCategoryId('project')).toBe(true)
    expect(isToolCategoryId('nonsense')).toBe(false)
  })
})

describe('defaultEnabledMap', () => {
  it('enables assistant categories and disables project by default', () => {
    const map = defaultEnabledMap()
    expect(map.files).toBe(true)
    expect(map.productivity).toBe(true)
    expect(map.project).toBe(false)
  })
})

describe('isCategoryEnabled', () => {
  it('uses the stored value when present', () => {
    expect(isCategoryEnabled({ project: true }, 'project')).toBe(true)
    expect(isCategoryEnabled({ files: false }, 'files')).toBe(false)
  })

  it('falls back to the category default when unset (forward compatible)', () => {
    // A map saved before a category existed has no entry for it.
    expect(isCategoryEnabled({}, 'files')).toBe(true)
    expect(isCategoryEnabled({}, 'project')).toBe(false)
  })
})

describe('resolveEnabledCategoryIds', () => {
  it('returns enabled categories in declaration order', () => {
    const ids = resolveEnabledCategoryIds(defaultEnabledMap())
    expect(ids).toContain('files')
    expect(ids).not.toContain('project')
    // Order matches TOOL_CATEGORIES declaration.
    const declared = TOOL_CATEGORIES.map(c => c.id).filter(id => ids.includes(id))
    expect(ids).toEqual(declared)
  })

  it('reflects explicit toggles', () => {
    const ids = resolveEnabledCategoryIds({ ...defaultEnabledMap(), project: true, web: false })
    expect(ids).toContain('project')
    expect(ids).not.toContain('web')
  })
})
