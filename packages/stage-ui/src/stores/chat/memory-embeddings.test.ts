import type { SemanticRecallDeps } from './memory-embeddings'
import type { MemoryItem, MemoryKind } from './memory-store'

import { describe, expect, it, vi } from 'vitest'

// NOTICE:
// These imports are Vite-only at runtime: the worker URL uses `?worker&url`
// and the provider/embed packages assume a browser/worker host. Under the
// node test env they would fail to resolve, so we stub them. runSemanticRecall
// takes an injected embedText, so the real provider is never exercised here.
// Removal condition: when these tests run in Vitest browser mode with a real
// worker, drop the mocks and assert on actual embeddings.
vi.mock('@xsai-transformers/embed', () => ({ createEmbedProvider: vi.fn() }))
vi.mock('@xsai-transformers/embed/worker?worker&url', () => ({ default: 'worker-url' }))
vi.mock('@xsai/embed', () => ({ embed: vi.fn() }))

const { runSemanticRecall } = await import('./memory-embeddings')

function mem(kind: MemoryKind, text: string, createdAt: number, embedding?: number[], embeddingModel?: string): MemoryItem {
  return { id: `${text}-${createdAt}`, kind, text, createdAt, embedding, embeddingModel }
}

/**
 * Deterministic 2-D "embedding" keyed by a substring so tests can assert
 * semantic ordering without a real model: tea-like -> [1,0], coffee-like ->
 * [0.9,0.1], anything else -> [0,1] (orthogonal to the query).
 *
 * @example embedFor('Likes green tea') -> [1, 0]
 */
function embedFor(text: string): number[] {
  const lower = text.toLowerCase()
  // Coffee checked first so a "coffee" text is not also caught by "drink".
  if (lower.includes('coffee')) {
    return [0.8, 0.6]
  }
  if (lower.includes('tea') || lower.includes('drink')) {
    return [1, 0]
  }
  return [0, 1]
}

describe('runSemanticRecall', () => {
  it('backfills missing embeddings, persists them, and ranks by meaning', async () => {
    const memories: MemoryItem[] = [
      mem('preference', 'Likes green tea', 1),
      mem('preference', 'Enjoys coffee in the morning', 2),
      mem('fact', 'Owns a bicycle', 3),
    ]
    const setEmbedding = vi.fn(async () => undefined)
    const embedText = vi.fn(async (text: string) => embedFor(text))

    const deps: SemanticRecallDeps = { memories, embedText, setEmbedding, model: 'm1' }
    // Query "what do I drink" -> [1,0]; tea (1.0) > coffee (0.8) >> bicycle (0).
    const result = await runSemanticRecall('what do I drink', deps, { minScore: 0.3 })

    // Ranked by semantic similarity, bicycle dropped (below minScore).
    expect(result.map(m => m.text)).toEqual(['Likes green tea', 'Enjoys coffee in the morning'])
    // Backfilled all 3 memory texts + the query = 4 embed calls.
    expect(embedText).toHaveBeenCalledTimes(4)
    // Each missing embedding was persisted with the active model.
    expect(setEmbedding).toHaveBeenCalledTimes(3)
    expect(setEmbedding).toHaveBeenCalledWith('Likes green tea-1', [1, 0], 'm1')
  })

  it('does not re-embed memories that already have a vector for the model', async () => {
    const memories: MemoryItem[] = [
      mem('preference', 'Likes green tea', 1, [1, 0], 'm1'),
      mem('fact', 'Owns a bicycle', 2, [0, 1], 'm1'),
    ]
    const setEmbedding = vi.fn(async () => undefined)
    const embedText = vi.fn(async (text: string) => embedFor(text))

    await runSemanticRecall('drink', { memories, embedText, setEmbedding, model: 'm1' }, { minScore: 0.3 })

    // Only the query is embedded; nothing to backfill or persist.
    expect(embedText).toHaveBeenCalledTimes(1)
    expect(setEmbedding).not.toHaveBeenCalled()
  })

  it('falls back to keyword search when the query embed throws/times out, without attempting backfill', async () => {
    // ROOT CAUSE:
    //
    // recall_memories(query) is awaited inside the chat turn (waitForTools). The
    // first embed lazily downloads the model; on a slow/proxied network it could
    // stall, and embedText had no timeout, so the tool — and the whole turn —
    // hung in "thinking" forever.
    //
    // Fix: embedText is bounded by a timeout (rejects on stall) and the query is
    // embedded FIRST, so a stall bails to keyword search immediately instead of
    // attempting N backfill embeds that each hit the same stall (N x timeout).
    const memories: MemoryItem[] = [
      // Two memories that still need embedding: if backfill were attempted before
      // the query, each would hit the same stall and multiply the delay.
      mem('fact', 'Likes green tea', 1),
      mem('fact', 'Owns a bicycle', 2),
    ]
    const embedText = vi.fn(async () => {
      throw new Error('embedding timed out')
    })
    const setEmbedding = vi.fn(async () => undefined)

    const result = await runSemanticRecall('tea', { memories, embedText, setEmbedding, model: 'm1' }, {})
    // Keyword substring match still works despite the embedding stall.
    expect(result.map(m => m.text)).toEqual(['Likes green tea'])
    // Only the query embed was attempted (1 call); no per-item backfill, so a
    // stall costs one timeout, not one per memory.
    expect(embedText).toHaveBeenCalledTimes(1)
    expect(setEmbedding).not.toHaveBeenCalled()
  })

  it('falls back to keyword search when no semantic match clears minScore', async () => {
    const memories: MemoryItem[] = [
      mem('fact', 'Owns a bicycle', 1, [0, 1], 'm1'),
      mem('fact', 'Has a cat named tea', 2, [0, 1], 'm1'),
    ]
    const embedText = vi.fn(async (text: string) => embedFor(text)) // query "tea" -> [1,0], both stored items [0,1]

    const result = await runSemanticRecall('tea', { memories, embedText, setEmbedding: vi.fn(async () => undefined), model: 'm1' }, { minScore: 0.5 })
    // No stored vector clears threshold (both orthogonal) -> keyword match on "tea".
    expect(result.map(m => m.text)).toEqual(['Has a cat named tea'])
  })

  it('returns memories unchanged for an empty query or empty store', async () => {
    const memories: MemoryItem[] = [mem('fact', 'x', 1)]
    const embedText = vi.fn(async () => [1, 0])
    expect(await runSemanticRecall('   ', { memories, embedText, setEmbedding: vi.fn(), model: 'm1' })).toBe(memories)
    expect(embedText).not.toHaveBeenCalled()
    expect(await runSemanticRecall('q', { memories: [], embedText, setEmbedding: vi.fn(), model: 'm1' })).toEqual([])
  })
})
