import type { ChatHistoryItem } from '../../types/chat'

import { merge } from '@moeru/std'

/**
 * Options controlling how much chat history is sent to the LLM per turn.
 */
export interface HistoryWindowOptions {
  /**
   * Trim is triggered only once the estimated history size crosses this
   * threshold, in estimated characters (see {@link estimateMessageChars}).
   *
   * @default 48_000
   */
  highWatermarkChars?: number
  /**
   * When a trim is triggered, the oldest droppable messages are removed until
   * the estimated size falls to or below this threshold, in estimated
   * characters. Must be lower than {@link HistoryWindowOptions.highWatermarkChars}.
   *
   * @default 32_000
   */
  lowWatermarkChars?: number
}

/**
 * Result of {@link applyHistoryWindow}.
 */
export interface HistoryWindowResult {
  /** Windowed view of the input; the input array is never mutated. */
  messages: ChatHistoryItem[]
  /** How many messages were dropped from the front of the droppable region. */
  droppedCount: number
}

/**
 * Defaults for {@link HistoryWindowOptions}.
 *
 * The high/low pair is a deliberate hysteresis (not a single cap): trimming
 * only when the size crosses `high` and then cutting all the way down to
 * `low` keeps the window's start boundary byte-stable for many turns, so the
 * provider-side KV-cache prefix built over the kept history stays valid
 * instead of being invalidated by a one-message slide on every send.
 *
 * Sizes are estimated characters, not tokens: ~4 chars/token for English,
 * ~1 char/token for CJK. 48k chars therefore lands between roughly 12k
 * (English) and 48k (CJK) tokens — conservative enough for small local
 * models while leaving long-conversation headroom for hosted ones.
 */
export const DEFAULT_HISTORY_WINDOW_OPTIONS = {
  highWatermarkChars: 48_000,
  lowWatermarkChars: 32_000,
} satisfies Required<HistoryWindowOptions>

// NOTICE:
// Image attachments are sent as base64 data URLs whose raw string length is
// enormous (hundreds of KB) but whose actual prompt cost is a roughly fixed
// vision-token budget per image. Counting the raw base64 length would evict
// the entire text history the moment one image appears, so each non-text
// content part is charged this flat estimate instead.
// Source: OpenAI/Anthropic vision pricing docs put one image at ~100-1600
// tokens; 1_500 chars (~375-1500 tokens) sits in that band.
// Removal condition: replace with provider-reported token usage once the
// stream layer exposes per-message usage data.
const NON_TEXT_PART_CHAR_ESTIMATE = 1_500

/**
 * Estimates the prompt cost of a single chat history item, in characters.
 *
 * Use when:
 * - Budgeting how much history fits under {@link HistoryWindowOptions}.
 *
 * Expects:
 * - `content` as a plain string or a CommonContentPart-like array; any other
 *   shape contributes the flat non-text estimate.
 *
 * Returns:
 * - Character estimate; text counts 1:1, non-text parts use a flat estimate.
 */
export function estimateMessageChars(message: ChatHistoryItem): number {
  const content = (message as { content?: unknown }).content

  if (typeof content === 'string')
    return content.length

  if (Array.isArray(content)) {
    let total = 0
    for (const part of content) {
      if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string')
        total += (part as { text: string }).text.length
      else
        total += NON_TEXT_PART_CHAR_ESTIMATE
    }
    return total
  }

  return content == null ? 0 : NON_TEXT_PART_CHAR_ESTIMATE
}

/**
 * Windows chat history to a bounded size before sending it to the LLM.
 *
 * Use when:
 * - Composing the per-turn message list in the chat orchestrator, so long
 *   sessions stop growing the prompt without bound (degrading both latency
 *   and reply quality on small-context models).
 *
 * Expects:
 * - `messages` in chronological order, optionally starting with one or more
 *   system messages (the persona prompt). The latest message is expected to
 *   be the user message that triggered this turn.
 *
 * Returns:
 * - A windowed copy that always keeps the leading system block, trims the
 *   oldest non-system messages only when the high watermark is crossed
 *   (hysteresis — see {@link DEFAULT_HISTORY_WINDOW_OPTIONS}), and re-aligns
 *   the window start to a `user` message so providers never see an
 *   assistant/tool message directly after the system prompt. The final
 *   message is never dropped.
 */
export function applyHistoryWindow(
  messages: ChatHistoryItem[],
  options?: HistoryWindowOptions,
): HistoryWindowResult {
  const { highWatermarkChars, lowWatermarkChars } = merge(DEFAULT_HISTORY_WINDOW_OPTIONS, options ?? {})

  // The leading system block (persona + style prompt) is always kept.
  let systemBlockEnd = 0
  while (systemBlockEnd < messages.length && messages[systemBlockEnd].role === 'system')
    systemBlockEnd += 1

  const systemBlock = messages.slice(0, systemBlockEnd)
  const droppable = messages.slice(systemBlockEnd)

  const sizes = messages.map(estimateMessageChars)
  let total = sizes.reduce((sum, size) => sum + size, 0)

  if (total <= highWatermarkChars)
    return { messages, droppedCount: 0 }

  // Drop oldest droppable messages until at or below the low watermark.
  // The newest message (the triggering user input) is never dropped.
  let dropCount = 0
  while (total > lowWatermarkChars && dropCount < droppable.length - 1) {
    total -= sizes[systemBlockEnd + dropCount]
    dropCount += 1
  }

  // Re-align the window start onto a user message: starting on an assistant
  // or tool message right after the system prompt is rejected by some
  // providers (orphaned tool results, consecutive-role violations).
  while (dropCount < droppable.length - 1 && droppable[dropCount].role !== 'user')
    dropCount += 1

  return {
    messages: [...systemBlock, ...droppable.slice(dropCount)],
    droppedCount: dropCount,
  }
}
