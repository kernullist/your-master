import type { MemoryItem, MemoryKind } from './memory-store'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { formatMemoriesForPrompt, normalizeMemoryKind, searchMemories, selectMemoriesForPrompt, useChatMemoryStore } from './memory-store'

function mem(kind: MemoryKind, text: string, createdAt: number): MemoryItem {
  return { id: `${kind}-${createdAt}`, kind, text, createdAt }
}

// In-memory localforage stub: the store only uses getItem/setItem.
const storage = new Map<string, unknown>()
vi.mock('localforage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => (storage.has(key) ? storage.get(key) : null)),
    setItem: vi.fn(async (key: string, value: unknown) => {
      storage.set(key, value)
      return value
    }),
  },
}))

describe('normalizeMemoryKind', () => {
  it('passes valid kinds through and defaults unknown/missing to fact', () => {
    expect(normalizeMemoryKind('instruction')).toBe('instruction')
    expect(normalizeMemoryKind('decision')).toBe('decision')
    expect(normalizeMemoryKind(undefined)).toBe('fact')
    expect(normalizeMemoryKind('nonsense')).toBe('fact')
  })
})

describe('formatMemoriesForPrompt', () => {
  it('returns an empty string for no memories (KV-cache stable)', () => {
    expect(formatMemoriesForPrompt([])).toBe('')
  })

  it('groups by kind, dates instructions/decisions/events, and omits dates for facts', () => {
    // 2026-06-10 local
    const instructionAt = new Date(2026, 5, 10, 9, 0, 0).getTime()
    const out = formatMemoriesForPrompt([
      { id: 'a', kind: 'fact', text: 'The user\'s name is 꿀보.', createdAt: 1 },
      { id: 'b', kind: 'instruction', text: 'Email the report on Mondays', createdAt: instructionAt },
      { id: 'c', kind: 'preference', text: 'Prefers Korean', createdAt: 2 },
    ])
    expect(out).toContain('## What you remember')
    // Instructions come first (declaration order) and carry a date.
    expect(out).toContain('### Standing instructions from the user\n- (2026-06-10) Email the report on Mondays')
    // Facts have no date.
    expect(out).toContain('### Facts about the user\n- The user\'s name is 꿀보.')
    expect(out).toContain('### User preferences\n- Prefers Korean')
  })
})

describe('selectMemoriesForPrompt', () => {
  it('keeps all instructions/decisions/preferences and only the most recent events/facts', () => {
    const items: MemoryItem[] = [
      mem('instruction', 'do X', 10),
      mem('decision', 'use Y', 11),
      mem('preference', 'likes Z', 12),
      mem('fact', 'old fact', 1),
      mem('fact', 'new fact', 100),
      mem('event', 'recent event', 99),
    ]
    const selected = selectMemoriesForPrompt(items, 2)
    const texts = selected.map(item => item.text)
    // All durable kinds kept.
    expect(texts).toContain('do X')
    expect(texts).toContain('use Y')
    expect(texts).toContain('likes Z')
    // Only the 2 most recent event/fact kept; the old fact dropped.
    expect(texts).toContain('new fact')
    expect(texts).toContain('recent event')
    expect(texts).not.toContain('old fact')
    // Output is sorted by createdAt ascending (stable for KV-cache).
    const times = selected.map(item => item.createdAt)
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })
})

describe('searchMemories', () => {
  it('filters by case-insensitive substring; empty query returns all', () => {
    const items = [mem('fact', 'Likes green tea', 1), mem('fact', 'Has a dog', 2)]
    expect(searchMemories(items, 'TEA').map(item => item.text)).toEqual(['Likes green tea'])
    expect(searchMemories(items, '  ')).toHaveLength(2)
    expect(searchMemories(items, 'cat')).toHaveLength(0)
  })
})

describe('useChatMemoryStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    storage.clear()
  })

  it('remembers an item with its kind and lists it', async () => {
    const store = useChatMemoryStore()
    await store.remember('char-1', 'The user likes tea.', 'preference', 1000)
    const items = store.list('char-1')
    expect(items).toHaveLength(1)
    expect(items[0].text).toBe('The user likes tea.')
    expect(items[0].kind).toBe('preference')
  })

  it('de-duplicates on (kind, text) but keeps same text under a different kind', async () => {
    const store = useChatMemoryStore()
    await store.remember('char-1', 'Use LM Studio', 'decision', 1000)
    const dupe = await store.remember('char-1', '  Use LM Studio  ', 'decision', 2000)
    expect(store.list('char-1')).toHaveLength(1)
    expect(dupe.createdAt).toBe(1000)
    // Same text, different kind -> a distinct memory.
    await store.remember('char-1', 'Use LM Studio', 'instruction', 3000)
    expect(store.list('char-1')).toHaveLength(2)
  })

  it('forgets an item by id', async () => {
    const store = useChatMemoryStore()
    const item = await store.remember('char-1', 'Temporary', 'fact', 1000)
    expect(await store.forget('char-1', item.id)).toBe(true)
    expect(store.list('char-1')).toHaveLength(0)
    expect(await store.forget('char-1', 'nope')).toBe(false)
  })

  it('persists across store instances and migrates pre-kind records to fact', async () => {
    // Seed storage with a legacy record that has no `kind`.
    storage.set('chat-memory-char-1', [{ id: 'old', text: 'Legacy fact', createdAt: 1000 }])

    const store = useChatMemoryStore()
    await store.ensureLoaded('char-1')
    const items = store.list('char-1')
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('fact')
    expect(items[0].text).toBe('Legacy fact')
  })
})
