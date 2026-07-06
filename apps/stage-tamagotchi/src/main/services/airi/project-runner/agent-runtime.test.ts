import type { AgentCallEvent, AgentRuntimeFetch } from './agent-runtime'

import { describe, expect, it, vi } from 'vitest'

import {
  AgentProviderHttpError,
  callAgentText,
  listCodexCliModels,
  parseCodexCliModels,
  resolveAgentChatCompletionsUrl,
} from './agent-runtime'

/** No-op sleep so retry tests never wait on real backoff timers. */
async function noSleep(): Promise<void> {}

/** Minimal successful chat-completion body used across runtime tests. */
function okChatBody(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] })
}

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

  it('parses Codex CLI model catalog output', () => {
    const result = parseCodexCliModels(JSON.stringify({
      models: [
        {
          slug: 'gpt-5.5',
          display_name: 'GPT-5.5',
          default_reasoning_effort: 'medium',
          supported_reasoning_efforts: ['low', 'medium', 'high'],
        },
        {
          display_name: 'Missing slug',
        },
      ],
    }))

    expect(result).toEqual([{
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['low', 'medium', 'high'],
    }])
  })

  it('lists Codex CLI models by executing the CLI catalog command', async () => {
    const codexExec = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        models: [
          { slug: 'gpt-5.5', display_name: 'GPT-5.5' },
          { slug: 'gpt-5.3-codex', display_name: 'gpt-5.3-codex' },
        ],
      }),
      stderr: '',
    }))

    const result = await listCodexCliModels({
      codexExec,
      cwd: 'F:\\workspace\\demo',
    })

    expect(result.map(model => model.id)).toEqual(['gpt-5.3-codex', 'gpt-5.5'])
    expect(codexExec).toHaveBeenCalledWith(['debug', 'models'], { cwd: 'F:\\workspace\\demo' })
  })

  it('calls Codex CLI in read-only exec mode and returns stdout text', async () => {
    const codexExec = vi.fn(async () => ({
      exitCode: 0,
      stdout: '{"action":"final","comment":"done"}\n',
      stderr: '',
    }))

    const result = await callAgentText({
      config: {
        provider: 'codex-cli',
        model: 'gpt-5.5',
        systemPrompt: 'worker',
      },
      messages: [{ role: 'user', content: 'Implement this' }],
      codexExec,
      projectRoot: 'F:\\workspace\\demo',
    })

    expect(result).toBe('{"action":"final","comment":"done"}')
    expect(codexExec).toHaveBeenCalledWith(expect.arrayContaining([
      '-a',
      'never',
      'exec',
      '--model',
      'gpt-5.5',
      '--sandbox',
      'read-only',
      '-',
    ]), expect.objectContaining({
      cwd: 'F:\\workspace\\demo',
      stdin: expect.stringContaining('Implement this'),
    }))
  })

  it('retries a transient 429 then returns the successful response', async () => {
    let call = 0
    const fetcher = vi.fn<AgentRuntimeFetch>(async () => {
      call += 1
      if (call === 1) {
        return {
          ok: false,
          status: 429,
          text: async () => JSON.stringify({ error: { message: 'rate limited' } }),
        }
      }
      return {
        ok: true,
        status: 200,
        text: async () => okChatBody('done'),
      }
    })

    const result = await callAgentText({
      config: { provider: 'openrouter', model: 'demo', systemPrompt: 'worker' },
      messages: [{ role: 'user', content: 'Implement this' }],
      fetcher,
      sleep: noSleep,
    })

    expect(result).toBe('done')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not retry a permanent 400 and surfaces the provider error', async () => {
    const fetcher = vi.fn<AgentRuntimeFetch>(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: 'bad request' } }),
    }))

    const error = await callAgentText({
      config: { provider: 'lm-studio', model: 'demo', systemPrompt: 'worker' },
      messages: [{ role: 'user', content: 'Implement this' }],
      fetcher,
      sleep: noSleep,
    }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AgentProviderHttpError)
    if (error instanceof AgentProviderHttpError) {
      expect(error.status).toBe(400)
      expect(error.message).toBe('bad request')
    }
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('surfaces the HTTP status when an error body is not JSON', async () => {
    // ROOT CAUSE:
    //
    // callAgentText previously ran JSON.parse(raw) BEFORE checking response.ok, so a transient
    // 5xx whose body is not JSON (a proxy HTML page, an empty body) threw a SyntaxError that
    // masked the real HTTP status and discarded the Retry-After header, breaking retry logic.
    //
    //   const parsed = JSON.parse(raw)      // throws SyntaxError on "<html>...502..."
    //   if (!response.ok) { throw ... }     // never reached
    //
    // We fixed this by checking response.ok first and wrapping non-JSON error bodies in
    // AgentProviderHttpError(status), so the status and Retry-After survive.
    const fetcher = vi.fn<AgentRuntimeFetch>(async () => ({
      ok: false,
      status: 502,
      text: async () => '<html><body>502 Bad Gateway</body></html>',
    }))

    const error = await callAgentText({
      config: { provider: 'openrouter', model: 'demo', systemPrompt: 'worker' },
      messages: [{ role: 'user', content: 'Implement this' }],
      fetcher,
      sleep: noSleep,
      maxAttempts: 1,
    }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AgentProviderHttpError)
    if (error instanceof AgentProviderHttpError) {
      expect(error.status).toBe(502)
      expect(error.message).toContain('502 Bad Gateway')
    }
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('sends max_tokens only when the config sets maxOutputTokens', async () => {
    let capturedBody: string | undefined
    const fetcher: AgentRuntimeFetch = async (_url, init) => {
      capturedBody = init.body
      return { ok: true, status: 200, text: async () => okChatBody('done') }
    }

    await callAgentText({
      config: { provider: 'lm-studio', model: 'demo', systemPrompt: 'worker', maxOutputTokens: 256 },
      messages: [{ role: 'user', content: 'Implement this' }],
      fetcher,
    })
    const withCap = JSON.parse(capturedBody ?? '{}') as { max_tokens?: number }
    expect(withCap.max_tokens).toBe(256)

    await callAgentText({
      config: { provider: 'lm-studio', model: 'demo', systemPrompt: 'worker' },
      messages: [{ role: 'user', content: 'Implement this' }],
      fetcher,
    })
    const withoutCap = JSON.parse(capturedBody ?? '{}') as { max_tokens?: number }
    expect(withoutCap.max_tokens).toBeUndefined()
  })

  it('requests JSON-object mode only when structuredOutput is enabled', async () => {
    let capturedBody: string | undefined
    const fetcher: AgentRuntimeFetch = async (_url, init) => {
      capturedBody = init.body
      return { ok: true, status: 200, text: async () => okChatBody('done') }
    }

    await callAgentText({
      config: { provider: 'lm-studio', model: 'demo', systemPrompt: 'worker', structuredOutput: true },
      messages: [{ role: 'user', content: 'Implement this' }],
      fetcher,
    })
    const withMode = JSON.parse(capturedBody ?? '{}') as { response_format?: { type: string } }
    expect(withMode.response_format).toEqual({ type: 'json_object' })

    await callAgentText({
      config: { provider: 'lm-studio', model: 'demo', systemPrompt: 'worker' },
      messages: [{ role: 'user', content: 'Implement this' }],
      fetcher,
    })
    const withoutMode = JSON.parse(capturedBody ?? '{}') as { response_format?: { type: string } }
    expect(withoutMode.response_format).toBeUndefined()
  })

  it('emits an observability event with usage on success and status on failure', async () => {
    const events: AgentCallEvent[] = []
    const okFetcher: AgentRuntimeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      }),
    })

    await callAgentText({
      config: { provider: 'lm-studio', model: 'demo', systemPrompt: 'worker' },
      messages: [{ role: 'user', content: 'hi' }],
      fetcher: okFetcher,
      onEvent: event => events.push(event),
    })

    expect(events).toHaveLength(1)
    expect(events[0].ok).toBe(true)
    expect(events[0].model).toBe('demo')
    expect(events[0].attempt).toBe(1)
    expect(events[0].finishReason).toBe('stop')
    expect(events[0].usage).toEqual({ promptTokens: 12, completionTokens: 3, totalTokens: 15 })

    const failEvents: AgentCallEvent[] = []
    const failFetcher: AgentRuntimeFetch = async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: 'bad request' } }),
    })

    await callAgentText({
      config: { provider: 'lm-studio', model: 'demo', systemPrompt: 'worker' },
      messages: [{ role: 'user', content: 'hi' }],
      fetcher: failFetcher,
      sleep: noSleep,
      onEvent: event => failEvents.push(event),
    }).catch(() => {})

    expect(failEvents).toHaveLength(1)
    expect(failEvents[0].ok).toBe(false)
    expect(failEvents[0].status).toBe(400)
  })

  it('does not retry when the external signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const fetcher: AgentRuntimeFetch = async (_url, init) => {
      calls += 1
      if (init.signal?.aborted)
        throw new DOMException('request aborted', 'AbortError')
      return { ok: true, status: 200, text: async () => okChatBody('done') }
    }
    const sleep = vi.fn(async () => {})

    await expect(callAgentText({
      config: { provider: 'lm-studio', model: 'demo', systemPrompt: 'worker' },
      messages: [{ role: 'user', content: 'Implement this' }],
      fetcher,
      signal: controller.signal,
      sleep,
    })).rejects.toThrow('request aborted')

    expect(calls).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})
