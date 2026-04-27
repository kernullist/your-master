import type { AgentModelConfig } from '@proj-airi/stage-projects'

/**
 * One chat message sent to an OpenAI-compatible local or remote provider.
 */
export interface AgentChatMessage {
  /** Message role accepted by chat completions APIs. */
  role: 'system' | 'user' | 'assistant'
  /** Plain text message content. */
  content: string
}

/**
 * Minimal fetch-like function injected for tests.
 */
export interface AgentRuntimeResponse {
  /** Whether the provider returned a 2xx response. */
  ok: boolean
  /** HTTP status code. */
  status: number
  /** Reads the response body as text. */
  text: () => Promise<string>
}

/**
 * Minimal fetch-like function injected for tests.
 */
export type AgentRuntimeFetch = (input: string, init: {
  body: string
  headers: Record<string, string>
  method: 'POST'
}) => Promise<AgentRuntimeResponse>

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
  error?: {
    message?: string
  }
}

/**
 * Resolves the OpenAI-compatible chat completions endpoint for an agent config.
 *
 * Use when:
 * - AIRI calls LM Studio, Ollama, or OpenRouter directly
 *
 * Expects:
 * - `baseUrl` may point either at `/v1` or directly at `/chat/completions`
 *
 * Returns:
 * - Full chat completions URL
 */
export function resolveAgentChatCompletionsUrl(config: AgentModelConfig): string {
  const baseUrl = config.baseUrl?.trim()
    || (config.provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1'
      : config.provider === 'ollama'
        ? 'http://localhost:11434/v1'
        : 'http://localhost:1234/v1')

  if (baseUrl.endsWith('/chat/completions'))
    return baseUrl
  return `${baseUrl.replace(/\/$/, '')}/chat/completions`
}

/**
 * Calls one configured AIRI worker/reviewer model and returns assistant text.
 *
 * Use when:
 * - Worker or reviewer agent needs one direct API completion
 *
 * Expects:
 * - Providers expose an OpenAI-compatible `/chat/completions` endpoint
 *
 * Returns:
 * - Assistant message text
 */
export async function callAgentText(params: {
  config: AgentModelConfig
  messages: AgentChatMessage[]
  fetcher?: AgentRuntimeFetch
}): Promise<string> {
  const fetcher = params.fetcher ?? fetch
  const response = await fetcher(resolveAgentChatCompletionsUrl(params.config), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(params.config.apiKey ? { authorization: `Bearer ${params.config.apiKey}` } : {}),
      ...(params.config.provider === 'openrouter' ? { 'HTTP-Referer': 'https://airi.moeru.ai', 'X-Title': 'AIRI' } : {}),
    },
    body: JSON.stringify({
      model: params.config.model,
      messages: [
        { role: 'system', content: params.config.systemPrompt },
        ...params.messages,
      ],
      temperature: 0.2,
    }),
  })
  const raw = await response.text()
  const parsed = JSON.parse(raw) as ChatCompletionResponse
  if (!response.ok) {
    throw new Error(parsed.error?.message ?? `Agent provider returned HTTP ${response.status}`)
  }

  const content = parsed.choices?.[0]?.message?.content?.trim()
  if (!content)
    throw new Error('Agent provider returned an empty response.')
  return content
}
