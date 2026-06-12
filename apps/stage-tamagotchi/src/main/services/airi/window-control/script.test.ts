import { describe, expect, it } from 'vitest'

import { parseWindowList, validateWindowMatch, WINDOW_LIST_MAX } from './script'

describe('validateWindowMatch', () => {
  it('rejects empty matches', () => {
    expect(validateWindowMatch('')).toContain('required')
    expect(validateWindowMatch('   ')).toContain('required')
  })

  it('rejects too-short matches to avoid hitting the wrong window', () => {
    expect(validateWindowMatch('a')).toContain('at least 2')
  })

  it('accepts a reasonable substring', () => {
    expect(validateWindowMatch('Notepad')).toBeUndefined()
  })
})

describe('parseWindowList', () => {
  it('returns an empty array for empty output (no windows)', () => {
    expect(parseWindowList('')).toEqual([])
    expect(parseWindowList('   ')).toEqual([])
  })

  it('normalizes a single bare object into a one-element array', () => {
    // PowerShell ConvertTo-Json emits a bare object when exactly one matches.
    const out = parseWindowList('{"Id":42,"ProcessName":"notepad","MainWindowTitle":"Untitled"}')
    expect(out).toEqual([{ processId: 42, process: 'notepad', title: 'Untitled' }])
  })

  it('parses an array of windows', () => {
    const out = parseWindowList('[{"Id":1,"ProcessName":"a","MainWindowTitle":"A"},{"Id":2,"ProcessName":"b","MainWindowTitle":"B"}]')
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({ processId: 2, process: 'b', title: 'B' })
  })

  it('drops malformed entries and tolerates invalid JSON', () => {
    expect(parseWindowList('not json')).toEqual([])
    const out = parseWindowList('[{"Id":1,"MainWindowTitle":"ok"},{"ProcessName":"no-id"}]')
    expect(out).toEqual([{ processId: 1, process: 'unknown', title: 'ok' }])
  })

  it('caps the list length', () => {
    const many = Array.from({ length: WINDOW_LIST_MAX + 10 }, (_, i) => ({ Id: i, ProcessName: 'p', MainWindowTitle: `w${i}` }))
    expect(parseWindowList(JSON.stringify(many))).toHaveLength(WINDOW_LIST_MAX)
  })
})
