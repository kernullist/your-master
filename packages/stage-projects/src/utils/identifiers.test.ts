import { describe, expect, it } from 'vitest'

import { createNextWorkItemIdentifier, hasDuplicateIdentifier, normalizeIssuePrefix, normalizeWorkItemIdentifier } from './identifiers.ts'

describe('normalizeIssuePrefix', () => {
  it('normalizes user-entered project prefixes', () => {
    expect(normalizeIssuePrefix('airi')).toBe('AIRI')
    expect(normalizeIssuePrefix('proj airi')).toBe('PROJAIRI')
  })
})

describe('normalizeWorkItemIdentifier', () => {
  it('normalizes work item identifiers', () => {
    expect(normalizeWorkItemIdentifier('airi-12')).toBe('AIRI-12')
    expect(normalizeWorkItemIdentifier(' AIRI 12 ')).toBe('AIRI-12')
  })
})

describe('hasDuplicateIdentifier', () => {
  it('detects duplicates after normalization', () => {
    expect(hasDuplicateIdentifier(['airi-12'], 'AIRI 12')).toBe(true)
    expect(hasDuplicateIdentifier(['airi-12'], 'AIRI-13')).toBe(false)
  })
})

describe('createNextWorkItemIdentifier', () => {
  it('creates the first project-prefixed identifier', () => {
    expect(createNextWorkItemIdentifier({
      issuePrefix: 'bc',
      identifiers: [],
    })).toBe('BC-1')
  })

  it('increments from existing identifiers with the same prefix', () => {
    expect(createNextWorkItemIdentifier({
      issuePrefix: 'BC',
      identifiers: ['BC-1', 'BC-2', 'AIRI-9'],
    })).toBe('BC-3')
  })
})
