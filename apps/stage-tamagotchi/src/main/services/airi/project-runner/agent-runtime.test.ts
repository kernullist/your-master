import { describe, expect, it, vi } from 'vitest'

import {
  callAgentText,
  resolveAgentChatCompletionsUrl,
} from './agent-runtime'

describe('agent runtime', () => {
  it('resolves provider default chat completion URLs', () => {
    expect(resolveAgentChatCompletionsUrl({
      provider: 'lm-studio',
      model: 'demo',
      systemPrompt: 'worker',
    })).toBe('http://localhost:1234/v1/chat/completions')
    expect(resolveAgentChatCompletionsUrl({
      provider: 'ollama',
      model: 'demo',
      systemPrompt: 'worker',
    })).toBe('http://localhost:11434/v1/chat/completions')
    expect(resolveAgentChatCompletionsUrl({
      provider: 'openrouter',
      model: 'demo',
      systemPrompt: 'worker',
    })).toBe('https://openrouter.ai/api/v1/chat/completions')
  })

  it('calls an OpenAI-compatible provider and returns assistant text', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: 'done' } }],
      }),
    }))

    const result = await callAgentText({
      config: {
        provider: 'lm-studio',
        model: 'demo',
        systemPrompt: 'worker',
      },
      messages: [{ role: 'user', content: 'Implement this' }],
      fetcher,
    })

    expect(result).toBe('done')
    expect(fetcher).toHaveBeenCalledWith('http://localhost:1234/v1/chat/completions', expect.objectContaining({
      method: 'POST',
    }))
  })
})
