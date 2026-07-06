import type { AgentModelConfig } from '@proj-airi/stage-projects'

import type { RetryDecision } from './retry'

import process from 'node:process'

import { spawn } from 'node:child_process'

import { isRetryableHttpStatus, parseRetryAfterMs, withRetry } from './retry'

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
  /** Response headers accessor; optional so injected test fakes may omit it. Used to read `Retry-After`. */
  headers?: { get: (name: string) => string | null }
}

/**
 * Minimal fetch-like function injected for tests.
 */
export type AgentRuntimeFetch = (input: string, init: {
  body: string
  headers: Record<string, string>
  method: 'POST'
  /** Abort signal that cancels the in-flight request on timeout or run cancellation. */
  signal?: AbortSignal
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
  /** Abort signal that kills the Codex child process on timeout or run cancellation. */
  signal?: AbortSignal
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
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
  error?: {
    message?: string
  }
}

/**
 * Structured event emitted once per provider request attempt for observability.
 */
export interface AgentCallEvent {
  /** Provider family used for the attempt. */
  provider: AgentModelConfig['provider']
  /** Model id used for the attempt. */
  model: string
  /** One-based attempt index within the retry sequence. */
  attempt: number
  /** Wall-clock duration of the attempt in milliseconds. */
  durationMs: number
  /** Whether the provider returned a usable 2xx response. */
  ok: boolean
  /** HTTP status when the attempt failed with a provider error. */
  status?: number
  /** Provider `finish_reason` for the choice, when present (for example 'stop' or 'length'). */
  finishReason?: string
  /** Token usage reported by the provider, when present. */
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
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

// NOTICE:
// Retry/backoff/timeout defaults are separate named constants (not one shared magic number)
// per the repo TypeScript regulations. Base 500ms, cap 30s, 4 attempts is the common
// exponential-backoff-with-full-jitter profile OpenAI/Anthropic SDKs use for transient errors.
/** Total provider request attempts including the first try. */
const DEFAULT_MAX_REQUEST_ATTEMPTS = 4
/** Base delay for exponential backoff between provider retries, in milliseconds. */
const DEFAULT_RETRY_BASE_DELAY_MS = 500
/** Upper bound for a single backoff wait, in milliseconds. */
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000
// NOTICE:
// Per-request wall-clock ceiling. Kept generous (5 min) because local providers (Ollama/LM Studio)
// can stall for minutes while cold-loading a large model on the first token; the goal is to catch a
// truly hung provider, not to abort legitimate slow local generation. Overridable per call.
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000

/**
 * Provider HTTP failure that preserves the status code and any `Retry-After` hint.
 *
 * Extends the built-in Error (allowed for runtime API subclasses) so the retry
 * classifier can distinguish transient statuses from permanent auth/validation errors.
 */
export class AgentProviderHttpError extends Error {
  /** HTTP status code returned by the provider. */
  readonly status: number
  /** Parsed `Retry-After` wait in milliseconds, when the provider sent one. */
  readonly retryAfterMs?: number

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message)
    this.name = 'AgentProviderHttpError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * Reads a Node-style `code` string from an unknown error without throwing.
 *
 * Use when:
 * - Classifying a thrown network error by its libuv code (ECONNRESET, ETIMEDOUT, ...)
 *
 * Expects:
 * - `error` may be anything a rejected promise produced
 *
 * Returns:
 * - The string `code` property, or undefined when absent
 */
function nodeErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    // Reading a dynamic diagnostic property off an unknown error value.
    const code = (error as Record<'code', unknown>).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

/**
 * Classifies a provider request error into a retry decision.
 *
 * Use when:
 * - {@link withRetry} wraps a provider request and must decide whether to retry
 *
 * Expects:
 * - Transient provider failures throw {@link AgentProviderHttpError} with a status
 * - Per-request timeouts abort with a `TimeoutError`; run cancellation aborts with an `AbortError`
 *
 * Returns:
 * - retryable=true for transient statuses, timeouts, and network errors; false for auth/validation and user cancellation
 */
function classifyAgentRequestError(error: unknown): RetryDecision {
  if (error instanceof AgentProviderHttpError)
    return { retryable: isRetryableHttpStatus(error.status), retryAfterMs: error.retryAfterMs }

  if (error instanceof Error) {
    // AbortSignal.timeout-style aborts surface as TimeoutError (retryable);
    // an explicit run cancellation surfaces as AbortError (never retried).
    if (error.name === 'TimeoutError')
      return { retryable: true }
    if (error.name === 'AbortError')
      return { retryable: false }
    // fetch reports network failures as TypeError; Node stream errors carry a libuv code.
    if (error instanceof TypeError)
      return { retryable: true }
    const code = nodeErrorCode(error)
    if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN' || code === 'EPIPE')
      return { retryable: true }
  }

  return { retryable: false }
}

/**
 * Creates a self-cleaning per-request timeout signal.
 *
 * Use when:
 * - A single provider request needs a wall-clock ceiling so a hung provider cannot stall the loop
 *
 * Expects:
 * - `dispose` is called after the request settles so the timer never leaks or blocks shutdown
 *
 * Returns:
 * - An abort signal that fires a `TimeoutError` after `timeoutMs`, plus a `dispose` to clear it
 */
function createRequestTimeout(timeoutMs: number): { signal: AbortSignal, dispose: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DOMException('Agent request timed out.', 'TimeoutError'))
  }, timeoutMs)
  // Unref so a pending timeout never keeps the Node process or a test runner alive.
  if (typeof timer === 'object' && timer && 'unref' in timer)
    timer.unref()

  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  }
}

/**
 * Combines several abort signals into one that aborts when any input aborts.
 *
 * Use when:
 * - A request must honor both a per-request timeout and an external run-cancellation signal
 *
 * Expects:
 * - Input signals outlive the returned signal or are cleaned up by the caller
 *
 * Returns:
 * - A signal that mirrors the first input to abort, with its abort reason
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  // NOTICE:
  // Implemented manually instead of AbortSignal.any() to avoid depending on a specific
  // Node/Electron version where AbortSignal.any may be unavailable. Listeners are { once }
  // and the combined signal is request-scoped and short-lived.
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

/**
 * Extracts a provider error message from an error response body without throwing.
 *
 * Before:
 * - '{"error":{"message":"rate limited"}}'   -> "rate limited"
 * - '<html>502 Bad Gateway</html>'           -> "<html>502 Bad Gateway</html>" (compact snippet)
 *
 * After:
 * - a short human-readable message, or undefined when the body is empty
 */
function extractProviderErrorMessage(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0)
    return undefined

  try {
    const parsed = JSON.parse(trimmed) as ChatCompletionResponse
    return parsed.error?.message ?? trimmed.slice(0, 200)
  }
  catch {
    // Non-JSON error body (proxy HTML page, plain text): surface a compact snippet.
    return trimmed.slice(0, 200)
  }
}

/**
 * Reads a response body as text, returning '' instead of throwing on read failure.
 */
async function readResponseTextSafely(response: AgentRuntimeResponse): Promise<string> {
  try {
    return await response.text()
  }
  catch {
    return ''
  }
}

/**
 * Parses a successful chat completion body into content plus observability signals.
 *
 * Use when:
 * - A 2xx provider response body must yield assistant text, finish reason, and token usage
 *
 * Expects:
 * - `raw` is the full response body of a successful request
 *
 * Returns:
 * - Trimmed assistant content (undefined when missing), finish reason, and normalized usage
 */
function parseChatCompletion(raw: string): {
  content?: string
  finishReason?: string
  usage?: AgentCallEvent['usage']
} {
  let parsed: ChatCompletionResponse
  try {
    parsed = JSON.parse(raw) as ChatCompletionResponse
  }
  catch {
    throw new Error('Agent provider returned a non-JSON response body.')
  }
  const choice = parsed.choices?.[0]
  return {
    content: choice?.message?.content?.trim(),
    finishReason: choice?.finish_reason,
    usage: parsed.usage
      ? {
          promptTokens: parsed.usage.prompt_tokens,
          completionTokens: parsed.usage.completion_tokens,
          totalTokens: parsed.usage.total_tokens,
        }
      : undefined,
  }
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
  signal?: AbortSignal
}): Promise<CodexCliExecResult> {
  return await new Promise((resolve, reject) => {
    const stdout: string[] = []
    const stderr: string[] = []

    // npm command shims are `.cmd` files on Windows and Node cannot execute them
    // with `shell: false`, so Windows uses the shell while prompts go through stdin.
    // The signal kills a hung `codex exec` on timeout or run cancellation.
    const child = spawn('codex', args, {
      cwd: options.cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      signal: options.signal,
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
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<string> {
  const codexExec = params.codexExec ?? runCodexCli
  // Bound the Codex subprocess so a hung `codex exec` cannot stall the loop forever.
  const timeout = createRequestTimeout(params.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
  try {
    const signal = params.signal ? anySignal([params.signal, timeout.signal]) : timeout.signal
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
      signal,
    })

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Codex CLI returned exit code ${result.exitCode}.`)
    }

    const content = result.stdout.trim()
    if (!content)
      throw new Error('Codex CLI returned an empty response.')
    return content
  }
  finally {
    timeout.dispose()
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
 * - Worker, reviewer, or project-manager agent needs one direct API completion
 *
 * Expects:
 * - Providers expose an OpenAI-compatible `/chat/completions` endpoint, or use `codex-cli`
 * - The OpenAI-compatible path is side-effect-free (request -> text), so it is safe to auto-retry
 *
 * Returns:
 * - Assistant message text
 *
 * Call stack:
 *
 * runWorkerWithTools / runReviewerAgent / runProjectManagerAgent (./orchestrator)
 *   -> {@link callAgentText}
 *     -> {@link withRetry}
 *       -> provider /chat/completions (fetch) OR {@link callCodexCliText}
 */
export async function callAgentText(params: {
  codexExec?: CodexCliExec
  config: AgentModelConfig
  messages: AgentChatMessage[]
  fetcher?: AgentRuntimeFetch
  projectRoot?: string
  /** Total request attempts including the first try. @default DEFAULT_MAX_REQUEST_ATTEMPTS */
  maxAttempts?: number
  /** Per-request wall-clock timeout in milliseconds. @default DEFAULT_REQUEST_TIMEOUT_MS */
  timeoutMs?: number
  /** External cancellation signal; an abort is not retried. */
  signal?: AbortSignal
  /** Sleep injected for deterministic retry tests. */
  sleep?: (ms: number) => Promise<void>
  /** Random source injected for deterministic backoff tests. */
  random?: () => number
  /** Optional observability sink invoked once per request attempt. */
  onEvent?: (event: AgentCallEvent) => void
}): Promise<string> {
  if (params.config.provider === 'codex-cli') {
    return await callCodexCliText({
      codexExec: params.codexExec,
      config: params.config,
      messages: params.messages,
      projectRoot: params.projectRoot,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
    })
  }

  const fetcher = params.fetcher ?? fetch
  const url = resolveAgentChatCompletionsUrl(params.config)
  const headers = {
    'content-type': 'application/json',
    ...(params.config.apiKey ? { authorization: `Bearer ${params.config.apiKey}` } : {}),
    ...(params.config.provider === 'openrouter' ? { 'HTTP-Referer': 'https://airi.moeru.ai', 'X-Title': 'AIRI' } : {}),
  }
  const body = JSON.stringify({
    model: params.config.model,
    messages: [
      { role: 'system', content: params.config.systemPrompt },
      ...params.messages,
    ],
    temperature: 0.2,
    // Send max_tokens only when configured; unset means provider default so whole-file writes are not truncated.
    ...(params.config.maxOutputTokens ? { max_tokens: params.config.maxOutputTokens } : {}),
    // Opt-in JSON-object mode so supporting providers guarantee syntactically valid JSON.
    ...(params.config.structuredOutput ? { response_format: { type: 'json_object' } } : {}),
  })
  const timeoutMs = params.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  // NOTICE:
  // Retry wraps ONLY the pure request->text call, never an orchestrator tool step, because
  // worker actions (write/replace/patch/shell) are non-idempotent and must never be replayed.
  // Do not lift this retry up into the worker/reviewer step loops.
  let attempt = 0
  return await withRetry(async () => {
    attempt += 1
    const startedAt = Date.now()
    const timeout = createRequestTimeout(timeoutMs)
    try {
      const signal = params.signal ? anySignal([params.signal, timeout.signal]) : timeout.signal
      const response = await fetcher(url, { method: 'POST', headers, body, signal })
      // NOTICE:
      // Check response.ok BEFORE parsing the body. Root cause of the previous bug: a transient
      // 429/5xx often returns a non-JSON body (proxy HTML, empty), so JSON.parse ran first and
      // threw a SyntaxError that masked the real status and discarded the Retry-After header.
      // See the regression test "surfaces the HTTP status when an error body is not JSON".
      if (!response.ok) {
        const errorText = await readResponseTextSafely(response)
        params.onEvent?.({
          provider: params.config.provider,
          model: params.config.model,
          attempt,
          durationMs: Date.now() - startedAt,
          ok: false,
          status: response.status,
        })
        throw new AgentProviderHttpError(
          extractProviderErrorMessage(errorText) ?? `Agent provider returned HTTP ${response.status}`,
          response.status,
          parseRetryAfterMs(response.headers?.get('retry-after')),
        )
      }

      const parsed = parseChatCompletion(await response.text())
      params.onEvent?.({
        provider: params.config.provider,
        model: params.config.model,
        attempt,
        durationMs: Date.now() - startedAt,
        ok: true,
        finishReason: parsed.finishReason,
        usage: parsed.usage,
      })
      if (!parsed.content)
        throw new Error('Agent provider returned an empty response.')
      return parsed.content
    }
    finally {
      timeout.dispose()
    }
  }, {
    maxAttempts: params.maxAttempts ?? DEFAULT_MAX_REQUEST_ATTEMPTS,
    baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
    maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
    classify: classifyAgentRequestError,
    sleep: params.sleep,
    random: params.random,
  })
}
