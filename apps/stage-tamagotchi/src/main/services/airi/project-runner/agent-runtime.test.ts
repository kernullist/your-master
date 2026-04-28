import { describe, expect, it, vi } from 'vitest'

import {
  callAgentText,
  listCodexCliModels,
  parseCodexCliModels,
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
})
