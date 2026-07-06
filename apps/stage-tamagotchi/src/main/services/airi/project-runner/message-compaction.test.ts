import type { AgentChatMessage } from './agent-runtime'

import { describe, expect, it } from 'vitest'

import { compactAgentMessages } from './message-compaction'

/** Builds a bulky tool-result user message that exceeds the clear threshold. */
function toolResult(prefix: string, body: string): AgentChatMessage {
  return { role: 'user', content: `${prefix}\n${body}` }
}

describe('compactAgentMessages', () => {
  it('returns the input unchanged when total content is under the trigger', () => {
    const messages: AgentChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: '{"action":"read","path":"a.ts"}' },
      toolResult('Tool result:', 'small body'),
    ]

    const result = compactAgentMessages(messages, { triggerTotalChars: 24000 })

    expect(result).toBe(messages)
  })

  it('clears old tool results but keeps the most recent ones at full fidelity', () => {
    const big = 'x'.repeat(5000)
    const messages: AgentChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'a1' },
      toolResult('Tool result:', `first ${big}`),
      { role: 'assistant', content: 'a2' },
      toolResult('Tool result:', `second ${big}`),
      { role: 'assistant', content: 'a3' },
      toolResult('Tool result:', `third ${big}`),
    ]

    const result = compactAgentMessages(messages, { keepRecentToolResults: 2, triggerTotalChars: 1000 })

    // Oldest tool result is cleared to a pointer that keeps a head hint.
    expect(result[3].content.startsWith('Tool result:')).toBe(true)
    expect(result[3].content).toContain('[cleared')
    expect(result[3].content).toContain('head: first')
    expect(result[3].content.length).toBeLessThan(messages[3].content.length)
    // The two most recent tool results survive intact.
    expect(result[5].content).toBe(messages[5].content)
    expect(result[7].content).toBe(messages[7].content)
  })

  it('never clears the system prompt, the task message, or assistant reasoning', () => {
    const big = 'y'.repeat(5000)
    const messages: AgentChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: `task ${big}` },
      { role: 'assistant', content: `decision ${big}` },
      toolResult('Tool result:', `payload ${big}`),
      { role: 'assistant', content: 'a2' },
      toolResult('Tool result:', `payload2 ${big}`),
    ]

    const result = compactAgentMessages(messages, { keepRecentToolResults: 1, triggerTotalChars: 1000 })

    // system prompt, task message, and assistant messages are preserved verbatim.
    expect(result[0].content).toBe(messages[0].content)
    expect(result[1].content).toBe(messages[1].content)
    expect(result[2].content).toBe(messages[2].content)
    // The single most recent tool result stays full; the older one is cleared.
    expect(result[3].content).toContain('[cleared')
    expect(result[5].content).toBe(messages[5].content)
  })

  it('clears reviewer tool results and leaves small results alone', () => {
    const big = 'z'.repeat(5000)
    const messages: AgentChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'a1' },
      toolResult('Reviewer tool result:', `big ${big}`),
      { role: 'assistant', content: 'a2' },
      toolResult('Reviewer tool result:', 'tiny'),
      { role: 'assistant', content: 'a3' },
      toolResult('Reviewer tool result:', `big2 ${big}`),
    ]

    const result = compactAgentMessages(messages, {
      keepRecentToolResults: 1,
      minCharsToClear: 400,
      triggerTotalChars: 1000,
    })

    // The oldest big reviewer result is cleared.
    expect(result[3].content).toContain('[cleared')
    // A tiny result below minCharsToClear is left as-is even though it is old.
    expect(result[5].content).toBe('Reviewer tool result:\ntiny')
    // The most recent big result is protected.
    expect(result[7].content).toBe(messages[7].content)
  })
})
