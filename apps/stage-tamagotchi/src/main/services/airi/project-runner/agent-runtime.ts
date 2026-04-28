import type { AgentModelConfig } from '@proj-airi/stage-projects'

import process from 'node:process'

import { spawn } from 'node:child_process'

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

/**
 * Result returned by a Codex CLI child process invocation.
 */
export interface CodexCliExecResult {
  /** Process exit code. */
  exitCode: number | null
  /** Captured standard output. */
  stdout: string
  /** Captured standard error. */
  stderr: string
}

/**
 * Minimal Codex CLI runner injected by tests.
 */
export type CodexCliExec = (args: string[], options: {
  cwd: string
  stdin?: string
}) => Promise<CodexCliExecResult>

/**
 * One model entry reported by `codex debug models`.
 */
export interface CodexCliModel {
  /** Stable model slug passed to `codex --model`. */
  id: string
  /** Human-friendly display name when Codex provides one. */
  name?: string
  /** Default reasoning effort reported by Codex, if present. */
  defaultReasoningEffort?: string
  /** Supported reasoning efforts reported by Codex, if present. */
  supportedReasoningEfforts: string[]
}

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

interface CodexCliModelCatalog {
  models?: Array<{
    slug?: string
    display_name?: string
    default_reasoning_effort?: string
    supported_reasoning_efforts?: string[]
  }>
}

/**
 * Runs the local Codex CLI and captures text output.
 *
 * Use when:
 * - AIRI must ask the installed Codex CLI for model data or non-interactive completions
 * - Tests need to replace the process boundary with a small fake runner
 *
 * Expects:
 * - `codex` is discoverable on PATH
 * - `cwd` points at the project folder Codex should inspect
 *
 * Returns:
 * - Exit code, stdout, and stderr from the child process
 */
export async function runCodexCli(args: string[], options: {
  cwd: string
  stdin?: string
}): Promise<CodexCliExecResult> {
  return await new Promise((resolve, reject) => {
    const stdout: string[] = []
    const stderr: string[] = []

    // npm command shims are `.cmd` files on Windows and Node cannot execute them
    // with `shell: false`, so Windows uses the shell while prompts go through stdin.
    const child = spawn('codex', args, {
      cwd: options.cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
    })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => stdout.push(String(chunk)))
    child.stderr.on('data', chunk => stderr.push(String(chunk)))
    child.on('error', reject)
    child.on('close', exitCode => resolve({
      exitCode,
      stdout: stdout.join(''),
      stderr: stderr.join(''),
    }))

    child.stdin.end(options.stdin ?? '')
  })
}

/**
 * Normalizes Codex CLI model catalog entries.
 *
 * Before:
 * - `{ "slug": "gpt-5.5", "display_name": "GPT-5.5" }`
 *
 * After:
 * - `{ id: "gpt-5.5", name: "GPT-5.5", supportedReasoningEfforts: [] }`
 */
export function parseCodexCliModels(raw: string): CodexCliModel[] {
  const catalog = JSON.parse(raw) as CodexCliModelCatalog
  return [...(catalog.models ?? [])]
    .map((model): CodexCliModel | undefined => {
      const id = model.slug?.trim()
      if (!id)
        return undefined

      return {
        id,
        name: model.display_name?.trim() || undefined,
        defaultReasoningEffort: model.default_reasoning_effort?.trim() || undefined,
        supportedReasoningEfforts: model.supported_reasoning_efforts?.filter(item => typeof item === 'string') ?? [],
      }
    })
    .filter((model): model is CodexCliModel => !!model)
}

/**
 * Lists locally available Codex CLI models by executing `codex debug models`.
 *
 * Use when:
 * - The settings UI needs the actual model list supported by the installed Codex CLI
 *
 * Expects:
 * - Codex CLI is installed and can run in the current environment
 *
 * Returns:
 * - Sorted model entries ready for UI selection
 */
export async function listCodexCliModels(params: {
  codexExec?: CodexCliExec
  cwd?: string
} = {}): Promise<CodexCliModel[]> {
  const codexExec = params.codexExec ?? runCodexCli
  const result = await codexExec(['debug', 'models'], { cwd: params.cwd ?? process.cwd() })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Codex CLI model discovery failed with exit code ${result.exitCode}.`)
  }

  return parseCodexCliModels(result.stdout).sort((a, b) => a.id.localeCompare(b.id))
}

function formatCodexCliPrompt(params: {
  config: AgentModelConfig
  messages: AgentChatMessage[]
}): string {
  return [
    `System:\n${params.config.systemPrompt}`,
    'Conversation:',
    ...params.messages.map(message => `${message.role.toUpperCase()}:\n${message.content}`),
    'Return only the final assistant response. Do not include execution logs or markdown fences unless the requested response is JSON.',
  ].join('\n\n')
}

async function callCodexCliText(params: {
  codexExec?: CodexCliExec
  config: AgentModelConfig
  messages: AgentChatMessage[]
  projectRoot?: string
}): Promise<string> {
  const codexExec = params.codexExec ?? runCodexCli
  const result = await codexExec([
    '-a',
    'never',
    'exec',
    '--model',
    params.config.model,
    '--sandbox',
    'read-only',
    '-',
  ], {
    cwd: params.projectRoot ?? process.cwd(),
    stdin: formatCodexCliPrompt(params),
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Codex CLI returned exit code ${result.exitCode}.`)
  }

  const content = result.stdout.trim()
  if (!content)
    throw new Error('Codex CLI returned an empty response.')
  return content
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
  codexExec?: CodexCliExec
  config: AgentModelConfig
  messages: AgentChatMessage[]
  fetcher?: AgentRuntimeFetch
  projectRoot?: string
}): Promise<string> {
  if (params.config.provider === 'codex-cli') {
    return await callCodexCliText({
      codexExec: params.codexExec,
      config: params.config,
      messages: params.messages,
      projectRoot: params.projectRoot,
    })
  }

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
