import type { MemoryItem, MemoryKind } from './memory-store'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cosineSimilarity,
  formatMemoriesForPrompt,
  memoriesNeedingEmbedding,
  normalizeMemoryKind,
  rankMemoriesBySimilarity,
  searchMemories,
  selectMemoriesForPrompt,
  useChatMemoryStore,
} from './memory-store'

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

describe('cosineSimilarity', () => {
  it('returns 1 for identical direction, 0 for orthogonal, and guards bad input', () => {
    // Identical direction (magnitude-independent) -> 1.
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1)
    // Orthogonal -> 0.
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    // Opposite direction -> -1.
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1)
    // Length mismatch and zero vector are guarded to 0 (no NaN poisoning).
    expect(cosineSimilarity([1, 0], [1])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
  })
})

describe('rankMemoriesBySimilarity', () => {
  function embedded(kind: MemoryKind, text: string, createdAt: number, embedding: number[], model = 'm1'): MemoryItem {
    return { id: `${text}-${createdAt}`, kind, text, createdAt, embedding, embeddingModel: model }
  }

  it('ranks by cosine descending, applies minScore, topK, and model filter', () => {
    const items: MemoryItem[] = [
      embedded('fact', 'tea', 1, [1, 0]), // cosine 1 with query
      embedded('fact', 'coffee', 2, [0.9, 0.1]), // high
      embedded('fact', 'unrelated', 3, [0, 1]), // cosine 0 -> below minScore
      embedded('fact', 'other-model', 4, [1, 0], 'm2'), // filtered out by model
      mem('fact', 'no-embedding', 5), // skipped (no vector)
    ]
    const ranked = rankMemoriesBySimilarity(items, [1, 0], { topK: 2, minScore: 0.3, model: 'm1' })
    const texts = ranked.map(r => r.memory.text)
    // Only the two strong, same-model matches, strongest first.
    expect(texts).toEqual(['tea', 'coffee'])
    expect(ranked[0].score).toBeCloseTo(1)
    expect(ranked[1].score).toBeGreaterThan(0.3)
  })

  it('breaks score ties by recency and returns [] for an empty query vector', () => {
    const items: MemoryItem[] = [
      embedded('fact', 'older', 1, [1, 0]),
      embedded('fact', 'newer', 2, [1, 0]),
    ]
    const ranked = rankMemoriesBySimilarity(items, [1, 0], { minScore: 0 })
    expect(ranked.map(r => r.memory.text)).toEqual(['newer', 'older'])
    expect(rankMemoriesBySimilarity(items, [], { minScore: 0 })).toEqual([])
  })
})

describe('memoriesNeedingEmbedding', () => {
  it('selects items missing a vector or made by a different model', () => {
    const items: MemoryItem[] = [
      { id: 'a', kind: 'fact', text: 'has m1', createdAt: 1, embedding: [1], embeddingModel: 'm1' },
      { id: 'b', kind: 'fact', text: 'has m2', createdAt: 2, embedding: [1], embeddingModel: 'm2' },
      { id: 'c', kind: 'fact', text: 'empty vec', createdAt: 3, embedding: [], embeddingModel: 'm1' },
      mem('fact', 'no vec', 4),
    ]
    const need = memoriesNeedingEmbedding(items, 'm1').map(i => i.text)
    expect(need).toContain('has m2')
    expect(need).toContain('empty vec')
    expect(need).toContain('no vec')
    expect(need).not.toContain('has m1')
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

  it('sets and persists an embedding by id, ignoring unknown ids', async () => {
    const store = useChatMemoryStore()
    const item = await store.remember('char-1', 'Likes green tea', 'preference', 1000)
    expect(await store.setEmbedding('char-1', item.id, [0.1, 0.2, 0.3], 'm1')).toBe(true)
    const stored = store.list('char-1')[0]
    expect(stored.embedding).toEqual([0.1, 0.2, 0.3])
    expect(stored.embeddingModel).toBe('m1')
    // Unknown id is a no-op.
    expect(await store.setEmbedding('char-1', 'nope', [0], 'm1')).toBe(false)
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
