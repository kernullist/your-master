import { describe, expect, it } from 'vitest'

import {
  findContentMatches,
  isSearchableTextFile,
  matchesName,
  SEARCH_MAX_LINE_CHARS,
  shouldSkipDirectory,
  validateSearchQuery,
} from './search'

describe('shouldSkipDirectory', () => {
  it('skips noise/huge directories case-insensitively', () => {
    expect(shouldSkipDirectory('node_modules')).toBe(true)
    expect(shouldSkipDirectory('.git')).toBe(true)
    expect(shouldSkipDirectory('$RECYCLE.BIN')).toBe(true)
  })

  it('does not skip ordinary folders', () => {
    expect(shouldSkipDirectory('Documents')).toBe(false)
    expect(shouldSkipDirectory('contracts')).toBe(false)
  })
})

describe('isSearchableTextFile', () => {
  it('accepts known text extensions', () => {
    expect(isSearchableTextFile('notes.md')).toBe(true)
    expect(isSearchableTextFile('config.JSON')).toBe(true)
    expect(isSearchableTextFile('a.ts')).toBe(true)
  })

  it('rejects binary and extensionless files', () => {
    expect(isSearchableTextFile('photo.png')).toBe(false)
    expect(isSearchableTextFile('archive.zip')).toBe(false)
    expect(isSearchableTextFile('Makefile')).toBe(false)
    expect(isSearchableTextFile('.env')).toBe(false) // leading dot, no real ext
  })
})

describe('matchesName', () => {
  it('matches case-insensitively', () => {
    expect(matchesName('2024_Contract_final.pdf', 'contract')).toBe(true)
    expect(matchesName('budget.xlsx', 'contract')).toBe(false)
  })
})

describe('findContentMatches', () => {
  it('finds matching lines with 1-based line numbers', () => {
    const content = 'alpha\nBeta contract signed\ngamma'
    expect(findContentMatches(content, 'contract', 10)).toEqual([
      { line: 2, text: 'Beta contract signed' },
    ])
  })

  it('is case-insensitive and trims lines', () => {
    const content = '   The CONTRACT   '
    expect(findContentMatches(content, 'contract', 10)).toEqual([
      { line: 1, text: 'The CONTRACT' },
    ])
  })

  it('respects the per-file limit', () => {
    const content = 'x\nx\nx\nx'
    expect(findContentMatches(content, 'x', 2)).toHaveLength(2)
  })

  it('caps very long matching lines', () => {
    const content = `prefix ${'y'.repeat(SEARCH_MAX_LINE_CHARS + 50)}`
    const [hit] = findContentMatches(content, 'prefix', 10)
    expect(hit.text.endsWith('…')).toBe(true)
    expect(hit.text.length).toBeLessThanOrEqual(SEARCH_MAX_LINE_CHARS + 1)
  })
})

describe('validateSearchQuery', () => {
  it('rejects empty or too-short queries', () => {
    expect(validateSearchQuery('')).toContain('required')
    expect(validateSearchQuery('a')).toContain('at least 2')
  })

  it('accepts a reasonable query', () => {
    expect(validateSearchQuery('contract')).toBeUndefined()
  })
})
