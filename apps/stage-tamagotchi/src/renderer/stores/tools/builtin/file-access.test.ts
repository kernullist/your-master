import { describe, expect, it } from 'vitest'

import { buildFreeAccessGuidance } from './file-access'

describe('buildFreeAccessGuidance', () => {
  it('tells the model to ask for a path when nothing is registered', () => {
    const text = buildFreeAccessGuidance([])
    expect(text).toContain('No free-access folders')
    expect(text).toContain('ASK which folder')
    expect(text).toContain('Do not invent')
  })

  it('lists registered roots and points vague writes at the first folder', () => {
    const text = buildFreeAccessGuidance([
      'F:\\kernullist\\notes',
      'D:\\work',
    ])
    expect(text).toContain('F:\\kernullist\\notes')
    expect(text).toContain('D:\\work')
    expect(text).toContain('first free-access folder: F:\\kernullist\\notes')
    expect(text).toContain('F:\\kernullist\\notes\\mood.md')
    expect(text).toContain('Prefer free-access folders')
  })
})
