import type { MemoryItem } from './memory-store'

import embedWorkerURL from '@xsai-transformers/embed/worker?worker&url'

import { createEmbedProvider } from '@xsai-transformers/embed'
import { embed } from '@xsai/embed'

import {
  memoriesNeedingEmbedding,
  rankMemoriesBySimilarity,
  searchMemories,
  SEMANTIC_RECALL_MIN_SCORE,
  SEMANTIC_RECALL_TOP_K,
  useChatMemoryStore,
} from './memory-store'

/**
 * Embedding model used for semantic memory recall. all-MiniLM-L6-v2 is a small
 * (~23MB) sentence-transformer that produces 384-dim normalized embeddings and
 * needs no task prefix, so it runs fully offline in a worker and suits short
 * memory texts. Stored on each item as `embeddingModel`; changing this value
 * invalidates cached vectors (they are re-embedded on next recall).
 */
export const MEMORY_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'

/**
 * Cap on how many missing embeddings are backfilled per recall call. Backfill
 * is sequential (the worker embeds one input at a time), so this bounds the
 * worst-case latency of a single recall when many memories lack vectors; the
 * rest are filled on subsequent recalls.
 */
const MAX_BACKFILL_PER_RECALL = 24

/**
 * Per-embed timeout. The FIRST embed lazily triggers the worker's one-time
 * model download (~23MB from a CDN); on a slow/proxied network that can stall
 * indefinitely. Because `recall_memories` is awaited inside the chat turn
 * (waitForTools), an unbounded embed would hang the whole turn in a "thinking"
 * state forever. Bounding it lets recall fall back to keyword search and the
 * turn complete; the worker keeps downloading in the background, so once the
 * model is cached later recalls embed within this budget and semantic recall
 * turns on. Generous enough for cached-model load + inference (sub-second).
 */
const EMBED_TIMEOUT_MS = 12_000

/**
 * Rejects with Error(`message`) if `promise` does not settle within `ms`,
 * otherwise resolves/rejects with the original outcome. Timer is always cleared.
 * Used to bound the embedding worker so a stalled model download cannot hang a
 * chat turn (see {@link EMBED_TIMEOUT_MS}).
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  }
  finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/**
 * Embeds a single text. Injected into {@link runSemanticRecall} so the
 * orchestration can be unit-tested without spinning up a worker.
 */
export type EmbedTextFn = (text: string) => Promise<number[]>

/**
 * Lazily-created local transformers embedding provider. Kept as a module
 * singleton so the worker (and its one-time model download) is created once
 * and reused across recalls. Created on first use rather than at import so an
 * app that never recalls never pays the worker/model cost.
 */
let provider: ReturnType<typeof createEmbedProvider> | undefined

function getProvider() {
  if (!provider) {
    // NOTICE:
    // createEmbedProvider takes a Worker instance (not a URL); we build one
    // from Vite's `?worker&url` import, matching the worker pattern used by
    // the whisper/kokoro adapters (new Worker(url, { type: 'module' })).
    // The provider's embed() auto-loads the model then runs feature-extraction
    // (pooling: 'mean', normalize: true) inside the worker.
    // Source: @xsai-transformers/embed (dist/index.js createEmbedProvider).
    const worker = new Worker(embedWorkerURL, { type: 'module' })
    provider = createEmbedProvider({ worker })
  }
  return provider
}

/**
 * Embeds one text with the local transformers model, returning a plain number
 * array (the worker returns a typed array, which is normalized to a numeric
 * array so it survives IndexedDB structured-clone and array math).
 *
 * Use when:
 * - You need a vector for a memory text or a recall query.
 *
 * Returns:
 * - A 384-dim normalized embedding for {@link MEMORY_EMBEDDING_MODEL}.
 */
export async function embedText(text: string): Promise<number[]> {
  // Bound the worker call so a stalled one-time model download cannot hang the
  // chat turn that awaits recall; on timeout callers fall back to keyword search.
  const { embedding } = await withTimeout(
    embed({
      ...getProvider().embed(MEMORY_EMBEDDING_MODEL),
      input: text,
    }),
    EMBED_TIMEOUT_MS,
    `embedding timed out after ${EMBED_TIMEOUT_MS}ms (model may still be downloading)`,
  )
  return Array.from(embedding)
}

/**
 * Options for {@link semanticRecall} / {@link runSemanticRecall}.
 */
export interface SemanticRecallOptions {
  /** Max results to return. @default SEMANTIC_RECALL_TOP_K */
  topK?: number
  /** Minimum cosine score to include. @default SEMANTIC_RECALL_MIN_SCORE */
  minScore?: number
}

/**
 * Dependencies for {@link runSemanticRecall}, injected for testability.
 */
export interface SemanticRecallDeps {
  /** Current memories for the character (source of truth). */
  memories: MemoryItem[]
  /** Embeds a single text into a vector. */
  embedText: EmbedTextFn
  /** Persists a freshly computed embedding back onto a memory. */
  setEmbedding: (id: string, embedding: number[], model: string) => Promise<unknown>
  /** Embedding model id; embeddings made by other models are recomputed. */
  model: string
}

/**
 * Backfills missing embeddings (bounded), then ranks memories by semantic
 * similarity to `query`. Falls back to keyword search when nothing embeds or
 * ranking yields nothing, so recall is never worse than the keyword path.
 *
 * Call stack:
 *
 * recall_memories tool / prompt selection
 *   -> {@link semanticRecall}
 *     -> {@link runSemanticRecall}
 *       -> {@link memoriesNeedingEmbedding} (which items lack a usable vector)
 *       -> deps.embedText (backfill + query, sequential)
 *       -> {@link rankMemoriesBySimilarity}
 *       -> {@link searchMemories} (keyword fallback)
 *
 * Use when:
 * - The model recalls by meaning ("what do I drink" -> "Likes green tea").
 *
 * Expects:
 * - `query` is non-empty; callers pass the raw user/tool query.
 *
 * Returns:
 * - Memories ordered by relevance (semantic when available, else keyword).
 */
export async function runSemanticRecall(
  query: string,
  deps: SemanticRecallDeps,
  options: SemanticRecallOptions = {},
): Promise<MemoryItem[]> {
  const { memories, model } = deps
  const trimmed = query.trim()
  if (!trimmed || memories.length === 0) {
    return memories
  }

  // Embed the query FIRST. This doubles as a readiness probe: if the worker's
  // model is still downloading (or otherwise stalls), this times out and we bail
  // to keyword search immediately, rather than attempting N backfill embeds that
  // would each hit the same stall and multiply the delay (the bug that hung the
  // chat turn in "thinking" forever).
  let queryEmbedding: number[]
  try {
    queryEmbedding = await deps.embedText(trimmed)
  }
  catch (error) {
    console.warn('[memory-embeddings] query embed failed; using keyword search:', error)
    return searchMemories(memories, trimmed)
  }

  // The model is loaded (the query embed succeeded), so backfilling missing
  // vectors is now fast. Bounded and sequential; per-item failures are tolerated
  // (those items just stay on the keyword path this round).
  const pending = memoriesNeedingEmbedding(memories, model).slice(0, MAX_BACKFILL_PER_RECALL)
  for (const item of pending) {
    try {
      const vector = await deps.embedText(item.text)
      await deps.setEmbedding(item.id, vector, model)
      item.embedding = vector
      item.embeddingModel = model
    }
    catch (error) {
      console.warn('[memory-embeddings] backfill failed (ignored):', error)
    }
  }

  const ranked = rankMemoriesBySimilarity(memories, queryEmbedding, {
    topK: options.topK ?? SEMANTIC_RECALL_TOP_K,
    minScore: options.minScore ?? SEMANTIC_RECALL_MIN_SCORE,
    model,
  }).map(scored => scored.memory)

  // No semantic hit above threshold -> keyword search so the caller still gets
  // exact-substring matches it would otherwise miss.
  return ranked.length > 0 ? ranked : searchMemories(memories, trimmed)
}

/**
 * Semantic recall over a character's stored memories using the local
 * transformers embedding model. Best-effort: resolves the memory store,
 * ensures it is loaded, and delegates to {@link runSemanticRecall}. Never
 * throws — on any failure it returns keyword results.
 *
 * Use when:
 * - The `recall_memories` tool receives a query and should retrieve by meaning.
 */
export async function semanticRecall(
  characterId: string,
  query: string,
  options: SemanticRecallOptions = {},
): Promise<MemoryItem[]> {
  const store = useChatMemoryStore()
  await store.ensureLoaded(characterId)
  const memories = store.list(characterId)

  try {
    return await runSemanticRecall(query, {
      memories,
      embedText,
      setEmbedding: (id, embedding, model) => store.setEmbedding(characterId, id, embedding, model),
      model: MEMORY_EMBEDDING_MODEL,
    }, options)
  }
  catch (error) {
    console.warn('[memory-embeddings] semantic recall failed; using keyword search:', error)
    return searchMemories(memories, query)
  }
}
