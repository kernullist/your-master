import localforage from 'localforage'

import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Kind of a remembered item. Distinguishing these lets the assistant answer
 * "what did I ask you to do?" vs "what did we decide?" and surface them
 * differently in the prompt.
 */
export type MemoryKind = 'instruction' | 'event' | 'decision' | 'preference' | 'fact'

/** All memory kinds, in prompt display order. */
export const MEMORY_KINDS: MemoryKind[] = ['instruction', 'decision', 'event', 'preference', 'fact']

/** A single remembered item, scoped to one character. */
export interface MemoryItem {
  id: string
  /** What kind of memory this is (instruction/decision/event/preference/fact). */
  kind: MemoryKind
  /** The memory text, e.g. "The user's name is 꿀보." */
  text: string
  createdAt: number
  /**
   * Semantic embedding of {@link MemoryItem.text}, used for meaning-based
   * recall (cosine similarity). Optional: computed lazily by the embedding
   * service and persisted alongside the item. Absent for items saved before
   * an embedding model was available or while one is still loading.
   */
  embedding?: number[]
  /**
   * Model id that produced {@link MemoryItem.embedding}. Stored so a vector
   * made by a different model is treated as stale (re-embedded) rather than
   * compared across incompatible vector spaces.
   */
  embeddingModel?: string
}

const VALID_KINDS = new Set<string>(MEMORY_KINDS)

/** Coerces an arbitrary value to a valid MemoryKind, defaulting to 'fact'. */
export function normalizeMemoryKind(value: unknown): MemoryKind {
  return typeof value === 'string' && VALID_KINDS.has(value) ? value as MemoryKind : 'fact'
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
        // Migrate pre-`kind` records (saved before categorization existed) by
        // defaulting them to 'fact'.
        memoriesByCharacter.value[characterId] = stored.map(item => ({
          ...item,
          kind: normalizeMemoryKind((item as Partial<MemoryItem>).kind),
        }))
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
   * Adds a memory for a character, de-duplicating on exact (kind, text) and
   * enforcing the per-character cap (oldest dropped). Returns the created item,
   * or the existing one when an identical memory already exists.
   */
  async function remember(characterId: string, text: string, kind: MemoryKind, now: number): Promise<MemoryItem> {
    await ensureLoaded(characterId)
    const trimmed = text.trim()

    const current = memoriesByCharacter.value[characterId] ?? []
    const existing = current.find(item => item.text === trimmed && item.kind === kind)
    if (existing) {
      return existing
    }

    memoryIdCounter += 1
    const item: MemoryItem = { id: `mem-${now}-${memoryIdCounter}`, kind, text: trimmed, createdAt: now }
    // Drop oldest entries first when over the cap.
    const next = [...current, item].slice(-MAX_MEMORIES_PER_CHARACTER)
    memoriesByCharacter.value = { ...memoriesByCharacter.value, [characterId]: next }
    await persist(characterId)
    return item
  }

  /**
   * Attaches (or refreshes) a memory's semantic embedding and persists it.
   * No-op when the id is unknown. Used by the embedding service to cache
   * vectors so recall does not re-embed unchanged memories every time.
   */
  async function setEmbedding(characterId: string, id: string, embedding: number[], model: string): Promise<boolean> {
    await ensureLoaded(characterId)
    const current = memoriesByCharacter.value[characterId] ?? []
    const index = current.findIndex(item => item.id === id)
    if (index < 0) {
      return false
    }
    const next = current.slice()
    next[index] = { ...next[index], embedding, embeddingModel: model }
    memoriesByCharacter.value = { ...memoriesByCharacter.value, [characterId]: next }
    await persist(characterId)
    return true
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
    setEmbedding,
    forget,
    clear,
  }
})

/**
 * How many of the most recent event/fact memories to inject into the prompt.
 * Instructions/decisions/preferences are always kept (few and important);
 * events/facts can grow unbounded, so only the most recent are surfaced — the
 * rest stay reachable via `recall_memories` search. Keeps the prompt bounded
 * without an index.
 */
export const PROMPT_RECENT_EVENT_FACT_LIMIT = 20

/** Kinds always kept in the prompt (low-volume, durable, high-value). */
const ALWAYS_PROMPTED_KINDS = new Set<MemoryKind>(['instruction', 'decision', 'preference'])

/**
 * Selects which memories to inject into the system prompt: all
 * instruction/decision/preference items, plus the most recent N event/fact
 * items. Returned in stable order (by createdAt asc) so the rendered section
 * stays byte-stable across sends until memory actually changes.
 *
 * Use when:
 * - Building the prompt memory section for a character that may have many
 *   facts/events.
 */
export function selectMemoriesForPrompt(memories: MemoryItem[], recentLimit = PROMPT_RECENT_EVENT_FACT_LIMIT): MemoryItem[] {
  const always = memories.filter(item => ALWAYS_PROMPTED_KINDS.has(item.kind))
  const recent = memories
    .filter(item => !ALWAYS_PROMPTED_KINDS.has(item.kind))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, recentLimit)
  return [...always, ...recent].sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Case-insensitive keyword search over memory text.
 *
 * Use when:
 * - The model needs to recall facts/events not currently in the prompt.
 */
export function searchMemories(memories: MemoryItem[], query: string): MemoryItem[] {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return memories
  }
  return memories.filter(item => item.text.toLowerCase().includes(needle))
}

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1] (higher = more
 * similar). Returns 0 for mismatched lengths or a zero-magnitude vector so a
 * malformed embedding never poisons ranking.
 *
 * Use when:
 * - Ranking memory embeddings against a query embedding for semantic recall.
 *
 * Expects:
 * - `a` and `b` are numeric vectors of the same dimensionality.
 *
 * Returns:
 * - The cosine of the angle between them; 0 when undefined (length mismatch
 *   or either vector is all-zero).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0
  }
  // Single pass: accumulate dot product and both squared magnitudes.
  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  if (magA === 0 || magB === 0) {
    return 0
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

/** A memory paired with its similarity score to a query. */
export interface ScoredMemory {
  memory: MemoryItem
  /** Cosine similarity to the query embedding, in [-1, 1]. */
  score: number
}

/**
 * Options for {@link rankMemoriesBySimilarity}.
 */
export interface RankBySimilarityOptions {
  /**
   * Maximum number of results to return (highest score first).
   * @default 8
   */
  topK?: number
  /**
   * Minimum cosine score to include. Drops weak matches so an unrelated query
   * does not surface noise.
   * @default 0.3
   */
  minScore?: number
  /**
   * When set, only memories whose `embeddingModel` equals this are considered
   * (vectors from other models live in incompatible spaces).
   */
  model?: string
}

/** Default cap on semantically ranked results. */
export const SEMANTIC_RECALL_TOP_K = 8

/** Default minimum cosine score for a semantic match to count. */
export const SEMANTIC_RECALL_MIN_SCORE = 0.3

/**
 * Ranks memories by cosine similarity of their stored embedding to a query
 * embedding, returning the strongest matches first.
 *
 * Use when:
 * - Performing meaning-based recall (e.g. query "what do I drink" matching a
 *   stored "Likes green tea") where keyword search would miss the link.
 *
 * Expects:
 * - `queryEmbedding` is produced by the same model that produced the items'
 *   embeddings; pass `options.model` to enforce this.
 * - Memories without an embedding (or with a non-matching model) are skipped,
 *   not treated as zero-similarity matches.
 *
 * Returns:
 * - Up to `topK` `{ memory, score }` pairs with `score >= minScore`, sorted by
 *   score descending (ties broken by recency).
 */
export function rankMemoriesBySimilarity(
  memories: MemoryItem[],
  queryEmbedding: number[],
  options: RankBySimilarityOptions = {},
): ScoredMemory[] {
  const { topK = SEMANTIC_RECALL_TOP_K, minScore = SEMANTIC_RECALL_MIN_SCORE, model } = options
  if (queryEmbedding.length === 0) {
    return []
  }

  const scored: ScoredMemory[] = []
  for (const memory of memories) {
    if (!memory.embedding || memory.embedding.length === 0) {
      continue
    }
    if (model && memory.embeddingModel !== model) {
      continue
    }
    const score = cosineSimilarity(queryEmbedding, memory.embedding)
    if (score >= minScore) {
      scored.push({ memory, score })
    }
  }

  // Highest similarity first; for equal scores prefer the more recent memory.
  scored.sort((a, b) => (b.score - a.score) || (b.memory.createdAt - a.memory.createdAt))
  return scored.slice(0, topK)
}

/**
 * Selects memories that still need an embedding for the given model: those
 * with no embedding yet, or whose cached embedding was made by a different
 * model. Used to backfill vectors incrementally before semantic recall.
 *
 * Expects:
 * - `model` is the id of the currently active embedding model.
 *
 * Returns:
 * - The subset of `memories` whose `embedding` is missing/empty or whose
 *   `embeddingModel` differs from `model`.
 */
export function memoriesNeedingEmbedding(memories: MemoryItem[], model: string): MemoryItem[] {
  return memories.filter(item => !item.embedding || item.embedding.length === 0 || item.embeddingModel !== model)
}

/** Heading shown for each memory kind. */
const KIND_HEADINGS: Record<MemoryKind, string> = {
  instruction: 'Standing instructions from the user',
  decision: 'Decisions made',
  event: 'Notable events',
  preference: 'User preferences',
  fact: 'Facts about the user',
}

/** Kinds whose date matters for the model to reason about ("when"). */
const DATED_KINDS = new Set<MemoryKind>(['instruction', 'decision', 'event'])

/**
 * Formats a createdAt timestamp as an ISO-like local date `YYYY-MM-DD`.
 * Stable (no relative "3 days ago") so the prompt stays KV-cache friendly.
 */
function formatMemoryDate(createdAt: number): string {
  const date = new Date(createdAt)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Formats a character's memories into a system-prompt section, grouped by kind
 * so the assistant can tell instructions/decisions/events/preferences/facts
 * apart. Instructions/decisions/events carry their date.
 *
 * Before:
 * - [{ kind: 'instruction', text: 'Email the report on Mondays', createdAt }]
 *
 * After:
 * - "## What you remember\n\n### Standing instructions from the user\n- (2026-06-10) Email the report on Mondays"
 *
 * Returns an empty string when there are no memories so the prompt stays
 * byte-stable (KV-cache friendly) for users who never store any.
 */
export function formatMemoriesForPrompt(memories: MemoryItem[]): string {
  if (memories.length === 0) {
    return ''
  }

  const sections: string[] = []
  for (const kind of MEMORY_KINDS) {
    const items = memories.filter(item => item.kind === kind)
    if (items.length === 0) {
      continue
    }
    const lines = items.map((item) => {
      return DATED_KINDS.has(kind) ? `- (${formatMemoryDate(item.createdAt)}) ${item.text}` : `- ${item.text}`
    }).join('\n')
    sections.push(`### ${KIND_HEADINGS[kind]}\n${lines}`)
  }

  return `## What you remember\n\n${sections.join('\n\n')}`
}
