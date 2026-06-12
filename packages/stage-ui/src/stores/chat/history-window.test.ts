import type { ChatHistoryItem } from '../../types/chat'

import { describe, expect, it } from 'vitest'

import { applyHistoryWindow, estimateMessageChars } from './history-window'

function systemMessage(content: string): ChatHistoryItem {
  return { role: 'system', content }
}

function userMessage(content: string): ChatHistoryItem {
  return { role: 'user', content }
}

function assistantMessage(content: string): ChatHistoryItem {
  return { role: 'assistant', content, slices: [], tool_results: [] }
}

describe('estimateMessageChars', () => {
  it('counts plain string content 1:1', () => {
    expect(estimateMessageChars(userMessage('hello'))).toBe(5)
  })

  it('counts text parts 1:1 and charges a flat estimate for non-text parts', () => {
    const message: ChatHistoryItem = {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(200_000)}` } },
      ],
    }
    const estimate = estimateMessageChars(message)
    expect(estimate).toBeGreaterThanOrEqual('look at this'.length)
    // The 200k-char base64 payload must NOT be counted at raw length,
    // otherwise a single image would evict the whole text history.
    expect(estimate).toBeLessThan(10_000)
  })

  it('treats missing content as zero cost', () => {
    expect(estimateMessageChars({ role: 'assistant', slices: [], tool_results: [] } as ChatHistoryItem)).toBe(0)
  })
})

describe('applyHistoryWindow', () => {
  it('returns the input untouched while under the high watermark', () => {
    const messages = [
      systemMessage('persona'),
      userMessage('hi'),
      assistantMessage('hello!'),
    ]
    const result = applyHistoryWindow(messages, { highWatermarkChars: 1_000, lowWatermarkChars: 500 })
    expect(result.messages).toBe(messages)
    expect(result.droppedCount).toBe(0)
  })

  it('trims oldest non-system messages down to the low watermark once over the high watermark', () => {
    const messages = [
      systemMessage('persona'),
      userMessage('a'.repeat(400)),
      assistantMessage('b'.repeat(400)),
      userMessage('c'.repeat(400)),
      assistantMessage('d'.repeat(400)),
      userMessage('e'.repeat(100)),
    ]
    const result = applyHistoryWindow(messages, { highWatermarkChars: 1_200, lowWatermarkChars: 600 })
    expect(result.droppedCount).toBeGreaterThan(0)
    expect(result.messages[0].role).toBe('system')
    expect(result.messages[0].content).toBe('persona')
    // The triggering (latest) user message always survives.
    expect(result.messages.at(-1)?.content).toBe('e'.repeat(100))
  })

  it('always keeps the leading system block even when everything else is oversized', () => {
    const messages = [
      systemMessage('s'.repeat(2_000)),
      userMessage('u'.repeat(2_000)),
    ]
    const result = applyHistoryWindow(messages, { highWatermarkChars: 100, lowWatermarkChars: 50 })
    expect(result.messages[0].role).toBe('system')
    expect(result.messages).toHaveLength(2)
    expect(result.droppedCount).toBe(0)
  })

  it('re-aligns the window start onto a user message after trimming', () => {
    const messages = [
      systemMessage('persona'),
      userMessage('a'.repeat(500)),
      assistantMessage('b'.repeat(300)),
      userMessage('c'.repeat(50)),
      assistantMessage('d'.repeat(50)),
      userMessage('e'.repeat(50)),
    ]
    // Size-based trimming alone stops right after dropping the 500-char user
    // message, which would leave the window starting on the assistant
    // message — the alignment pass must advance it to the next user message.
    const result = applyHistoryWindow(messages, { highWatermarkChars: 900, lowWatermarkChars: 500 })
    const firstNonSystem = result.messages.find(message => message.role !== 'system')
    expect(firstNonSystem?.role).toBe('user')
    expect(firstNonSystem?.content).toBe('c'.repeat(50))
  })

  it('never drops the final message even under an impossible budget', () => {
    const messages = [
      systemMessage('persona'),
      userMessage('a'.repeat(500)),
      assistantMessage('b'.repeat(500)),
      userMessage('final question'),
    ]
    const result = applyHistoryWindow(messages, { highWatermarkChars: 10, lowWatermarkChars: 5 })
    expect(result.messages.at(-1)?.content).toBe('final question')
  })

  it('is idempotent right after a trim (hysteresis keeps the boundary stable)', () => {
    const messages = [
      systemMessage('persona'),
      ...Array.from({ length: 20 }, (_, i) => i % 2 === 0
        ? userMessage(`u${i} ${'x'.repeat(300)}`)
        : assistantMessage(`a${i} ${'y'.repeat(300)}`)),
    ]
    const options = { highWatermarkChars: 3_000, lowWatermarkChars: 1_500 }
    const first = applyHistoryWindow(messages, options)
    expect(first.droppedCount).toBeGreaterThan(0)

    // Re-windowing the already-trimmed history must be a no-op: the trimmed
    // size sits at/below the low watermark, well under the high watermark,
    // so the kept prefix stays byte-stable across subsequent turns.
    const second = applyHistoryWindow(first.messages, options)
    expect(second.droppedCount).toBe(0)
    expect(second.messages).toBe(first.messages)
  })
})
