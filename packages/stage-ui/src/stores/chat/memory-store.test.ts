import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { formatMemoriesForPrompt, useChatMemoryStore } from './memory-store'

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

describe('formatMemoriesForPrompt', () => {
  it('returns an empty string for no memories (KV-cache stable)', () => {
    expect(formatMemoriesForPrompt([])).toBe('')
  })

  it('renders a bulleted memory section', () => {
    const out = formatMemoriesForPrompt([
      { id: 'a', text: 'The user\'s name is 꿀보.', createdAt: 1 },
      { id: 'b', text: 'Prefers Korean.', createdAt: 2 },
    ])
    expect(out).toBe('## What you remember about the user\n- The user\'s name is 꿀보.\n- Prefers Korean.')
  })
})

describe('useChatMemoryStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    storage.clear()
  })

  it('remembers a fact and lists it', async () => {
    const store = useChatMemoryStore()
    await store.remember('char-1', 'The user likes tea.', 1000)
    const items = store.list('char-1')
    expect(items).toHaveLength(1)
    expect(items[0].text).toBe('The user likes tea.')
  })

  it('trims whitespace and de-duplicates identical facts', async () => {
    const store = useChatMemoryStore()
    await store.remember('char-1', 'Likes tea.', 1000)
    const second = await store.remember('char-1', '  Likes tea.  ', 2000)
    expect(store.list('char-1')).toHaveLength(1)
    // The existing item is returned, not a duplicate.
    expect(second.createdAt).toBe(1000)
  })

  it('scopes memories per character', async () => {
    const store = useChatMemoryStore()
    await store.remember('char-1', 'Fact A', 1000)
    await store.remember('char-2', 'Fact B', 1001)
    expect(store.list('char-1').map(item => item.text)).toEqual(['Fact A'])
    expect(store.list('char-2').map(item => item.text)).toEqual(['Fact B'])
  })

  it('forgets a fact by id', async () => {
    const store = useChatMemoryStore()
    const item = await store.remember('char-1', 'Temporary fact', 1000)
    expect(await store.forget('char-1', item.id)).toBe(true)
    expect(store.list('char-1')).toHaveLength(0)
    // Forgetting an unknown id is a no-op.
    expect(await store.forget('char-1', 'nope')).toBe(false)
  })

  it('persists across store instances via localforage', async () => {
    const first = useChatMemoryStore()
    await first.remember('char-1', 'Durable fact', 1000)

    // Simulate an app restart: fresh pinia, but the same backing storage.
    setActivePinia(createPinia())
    const second = useChatMemoryStore()
    await second.ensureLoaded('char-1')
    expect(second.list('char-1').map(item => item.text)).toEqual(['Durable fact'])
  })
})
