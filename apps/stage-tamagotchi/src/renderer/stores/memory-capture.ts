import type { MemoryKind } from '@proj-airi/stage-ui/stores/chat/memory-store'
import type { ChatProvider } from '@xsai-ext/providers/utils'

import { normalizeMemoryKind, useChatMemoryStore } from '@proj-airi/stage-ui/stores/chat/memory-store'
import { generateText } from '@xsai/generate-text'

/** A memory item proposed by the extractor. */
export interface ExtractedMemory {
  kind: MemoryKind
  text: string
}

/** Max items accepted from a single extraction (noise guard). */
export const MAX_EXTRACTED_PER_TURN = 5

/** Max chars of a single extracted item. */
const MAX_EXTRACTED_TEXT_CHARS = 300

/**
 * Parses the extractor LLM's raw output into validated memory items.
 *
 * Before:
 * - '```json\n[{"kind":"instruction","text":"Email Mondays"}]\n```'
 * - 'Sure! [] nothing to save'
 *
 * After:
 * - [{ kind: 'instruction', text: 'Email Mondays' }]
 * - []
 *
 * Tolerant of markdown fences and surrounding prose: extracts the first JSON
 * array, validates each entry has a non-empty string `text`, coerces `kind`
 * to a valid value (default 'fact'), trims/caps text, and caps the count.
 * Returns [] on any parse failure (best-effort, never throws).
 */
export function parseExtractedMemories(rawText: string): ExtractedMemory[] {
  if (!rawText) {
    return []
  }

  // Prefer fenced content, else the first bracketed array in the text.
  // Strip an opening fence (and optional `json` tag) then a trailing fence;
  // done with two simple replaces to avoid a backtracking-prone single regex.
  const candidate = rawText
    .replace(/```[a-z]*\n?/i, '')
    .replace(/```\s*$/, '')
  const arrayMatch = candidate.match(/\[[\s\S]*\]/)
  if (!arrayMatch) {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(arrayMatch[0])
  }
  catch {
    return []
  }
  if (!Array.isArray(parsed)) {
    return []
  }

  const out: ExtractedMemory[] = []
  for (const entry of parsed) {
    if (out.length >= MAX_EXTRACTED_PER_TURN) {
      break
    }
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const text = (entry as { text?: unknown }).text
    if (typeof text !== 'string' || !text.trim()) {
      continue
    }
    out.push({
      kind: normalizeMemoryKind((entry as { kind?: unknown }).kind),
      text: text.trim().slice(0, MAX_EXTRACTED_TEXT_CHARS),
    })
  }
  return out
}

/**
 * Builds the extraction messages. `knownTexts` are the user's existing memory
 * texts so the model only proposes genuinely new items (paraphrase dedup).
 */
export function buildExtractionMessages(userText: string, assistantText: string, knownTexts: string[]) {
  const system = [
    'You extract durable long-term memory items from one conversation turn for a personal assistant.',
    'Output ONLY a JSON array, nothing else. Each element is {"kind": one of "instruction"|"decision"|"event"|"preference"|"fact", "text": a concise third-person statement}.',
    'Capture only durable things the USER expressed this turn: standing instructions they gave you, decisions that were made, notable events, lasting preferences, or stable facts about them.',
    'Do NOT capture: questions, one-off requests that were already handled this turn, small talk, anything transient, secrets/passwords/sensitive data, or anything already in the "Already known" list (including paraphrases).',
    'If there is nothing durable and new, output exactly [].',
  ].join('\n')

  const known = knownTexts.length ? knownTexts.map(t => `- ${t}`).join('\n') : '(none)'
  const user = `Already known:\n${known}\n\nConversation turn:\nUser: ${userText}\nAssistant: ${assistantText}`

  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ]
}

/**
 * Extracts durable memories from the just-completed turn and stores any new
 * ones. Best-effort and side-effect-only: never throws, intended to run
 * fire-and-forget after a chat turn so it does not block the reply.
 *
 * Call stack:
 *
 * chat-sync executeIngest (after ingest resolves)
 *   -> {@link extractAndStoreMemories}
 *     -> {@link buildExtractionMessages} -> generateText
 *       -> {@link parseExtractedMemories} -> memory store remember()
 */
export async function extractAndStoreMemories(deps: {
  chatProvider: ChatProvider
  modelId: string
  characterId: string
  userText: string
  assistantText: string
  now: number
}): Promise<ExtractedMemory[]> {
  const { chatProvider, modelId, characterId, userText, assistantText, now } = deps

  // Skip trivial turns where there is unlikely to be anything durable.
  if (!userText || userText.trim().length < 8) {
    return []
  }

  try {
    const memoryStore = useChatMemoryStore()
    await memoryStore.ensureLoaded(characterId)
    const knownTexts = memoryStore.list(characterId).map(item => item.text)

    const chatConfig = chatProvider.chat(modelId)
    const response = await generateText({
      ...chatConfig,
      messages: buildExtractionMessages(userText, assistantText, knownTexts),
      headers: { 'Accept-Encoding': 'identity' },
    })

    const extracted = parseExtractedMemories(response.text ?? '')
    for (const item of extracted) {
      await memoryStore.remember(characterId, item.text, item.kind, now)
    }
    return extracted
  }
  catch (error) {
    console.warn('[memory-capture] extraction failed (ignored):', error)
    return []
  }
}
