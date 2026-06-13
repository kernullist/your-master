import localforage from 'localforage'

import { defineStore } from 'pinia'
import { ref } from 'vue'

/** A single remembered fact about the user, scoped to one character. */
export interface MemoryItem {
  id: string
  /** The fact text, e.g. "The user's name is 꿀보." */
  text: string
  createdAt: number
}

/** Cap on stored facts per character; oldest are dropped past this. */
const MAX_MEMORIES_PER_CHARACTER = 200

/** localforage key prefix; one record per character holds its memory array. */
const STORAGE_KEY_PREFIX = 'chat-memory-'

/**
 * Monotonic id counter. `mem-${now}-${listLength}` reused ids after the cap
 * dropped old entries (length is reused), so a stale id reference in a later
 * forget() could match the wrong fact; a counter guarantees uniqueness.
 */
let memoryIdCounter = 0

function storageKey(characterId: string) {
  return `${STORAGE_KEY_PREFIX}${characterId}`
}

/**
 * Cross-session long-term memory, scoped per character card.
 *
 * Use when:
 * - The assistant should retain facts learned in conversation (the user's
 *   name, preferences, ongoing projects) across sessions and app restarts.
 *
 * Persistence:
 * - One localforage (IndexedDB) record per character id; the in-memory map
 *   is the reactive source of truth and is hydrated lazily per character.
 *
 * Why a store, not an IPC service:
 * - Unlike file/shell tools, memory needs no OS privileges — it lives in the
 *   renderer's IndexedDB, so tools call this store directly.
 */
export const useChatMemoryStore = defineStore('chat-memory', () => {
  const memoriesByCharacter = ref<Record<string, MemoryItem[]>>({})
  const loaded = new Set<string>()

  async function ensureLoaded(characterId: string) {
    if (loaded.has(characterId)) {
      return
    }

    try {
      const stored = await localforage.getItem<MemoryItem[]>(storageKey(characterId))
      if (Array.isArray(stored)) {
        memoriesByCharacter.value[characterId] = stored
      }
    }
    catch (error) {
      console.error('[chat-memory] failed to load memories', error)
    }
    finally {
      loaded.add(characterId)
    }
  }

  async function persist(characterId: string) {
    try {
      await localforage.setItem(storageKey(characterId), [...(memoriesByCharacter.value[characterId] ?? [])])
    }
    catch (error) {
      console.error('[chat-memory] failed to persist memories', error)
    }
  }

  function list(characterId: string): MemoryItem[] {
    return memoriesByCharacter.value[characterId] ?? []
  }

  /**
   * Adds a fact for a character, de-duplicating on exact text and enforcing
   * the per-character cap (oldest dropped). Returns the created item, or the
   * existing one when the text already exists.
   */
  async function remember(characterId: string, text: string, now: number): Promise<MemoryItem> {
    await ensureLoaded(characterId)
    const trimmed = text.trim()

    const current = memoriesByCharacter.value[characterId] ?? []
    const existing = current.find(item => item.text === trimmed)
    if (existing) {
      return existing
    }

    memoryIdCounter += 1
    const item: MemoryItem = { id: `mem-${now}-${memoryIdCounter}`, text: trimmed, createdAt: now }
    // Drop oldest entries first when over the cap.
    const next = [...current, item].slice(-MAX_MEMORIES_PER_CHARACTER)
    memoriesByCharacter.value = { ...memoriesByCharacter.value, [characterId]: next }
    await persist(characterId)
    return item
  }

  /** Removes a fact by id; returns true when something was removed. */
  async function forget(characterId: string, id: string): Promise<boolean> {
    await ensureLoaded(characterId)
    const current = memoriesByCharacter.value[characterId] ?? []
    const next = current.filter(item => item.id !== id)
    if (next.length === current.length) {
      return false
    }

    memoriesByCharacter.value = { ...memoriesByCharacter.value, [characterId]: next }
    await persist(characterId)
    return true
  }

  /** Clears all facts for a character. */
  async function clear(characterId: string) {
    await ensureLoaded(characterId)
    memoriesByCharacter.value = { ...memoriesByCharacter.value, [characterId]: [] }
    await persist(characterId)
  }

  return {
    memoriesByCharacter,
    ensureLoaded,
    list,
    remember,
    forget,
    clear,
  }
})

/**
 * Formats a character's memories into a system-prompt section.
 *
 * Before:
 * - [{ text: "The user's name is 꿀보." }, { text: "Prefers Korean." }]
 *
 * After:
 * - "## What you remember about the user\n- The user's name is 꿀보.\n- Prefers Korean."
 *
 * Returns an empty string when there are no memories so the prompt stays
 * byte-stable (KV-cache friendly) for users who never store any.
 */
export function formatMemoriesForPrompt(memories: MemoryItem[]): string {
  if (memories.length === 0) {
    return ''
  }

  const lines = memories.map(item => `- ${item.text}`).join('\n')
  return `## What you remember about the user\n${lines}`
}
