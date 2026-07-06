/**
 * Retry decision returned by a {@link RetryClassifier}.
 */
export interface RetryDecision {
  /** Whether the failed attempt should be retried. */
  retryable: boolean
  /** Minimum wait before the next attempt, usually parsed from a `Retry-After` header. */
  retryAfterMs?: number
}

/**
 * Inspects a thrown error and decides whether the attempt can be retried.
 *
 * @param error - The value thrown by the retried function.
 */
export type RetryClassifier = (error: unknown) => RetryDecision

/**
 * Options controlling {@link withRetry}.
 */
export interface WithRetryOptions {
  /** Total attempts including the first try. Values below 1 behave like a single attempt. */
  maxAttempts: number
  /** Base delay used by the exponential backoff, in milliseconds. */
  baseDelayMs: number
  /** Upper bound for a single backoff wait, in milliseconds. */
  maxDelayMs: number
  /** Classifies a thrown error into a retry decision. */
  classify: RetryClassifier
  /**
   * Sleep implementation.
   *
   * @default a `setTimeout`-based sleep that does not keep the event loop alive
   */
  sleep?: (ms: number) => Promise<void>
  /**
   * Random source in the range [0, 1) used for full jitter.
   *
   * @default Math.random
   */
  random?: () => number
}

// NOTICE:
// Retry/backoff/limit values are intentionally separate named constants rather than
// one shared magic number, per the repo TypeScript regulations on retry values.
/** HTTP statuses that indicate a transient provider failure worth retrying. */
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529])

/**
 * Default sleep that yields for `ms` without keeping the Node event loop alive.
 *
 * Use when:
 * - {@link withRetry} needs to wait between attempts and no test sleep is injected
 *
 * Expects:
 * - `ms` is a non-negative integer
 *
 * Returns:
 * - A promise resolved after roughly `ms` milliseconds
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // The timer is unref'd so a pending backoff never blocks process/test shutdown.
    const timer = setTimeout(resolve, ms)
    if (typeof timer === 'object' && timer && 'unref' in timer)
      timer.unref()
  })
}

/**
 * Reports whether an HTTP status is a transient failure that should be retried.
 *
 * Use when:
 * - Classifying a provider HTTP error before deciding to retry
 *
 * Expects:
 * - `status` is a standard HTTP status code
 *
 * Returns:
 * - True for 408/429/500/502/503/504/529, false otherwise (never retry 4xx auth/validation)
 */
export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status)
}

/**
 * Parses a `Retry-After` header value into milliseconds.
 *
 * Before:
 * - "120"                              -> 120000
 * - "Wed, 21 Oct 2026 07:28:00 GMT"    -> milliseconds until that instant (>= 0)
 *
 * After:
 * - number of milliseconds to wait, or undefined when the header is missing/unparseable
 *
 * @param headerValue - Raw `Retry-After` header value, or null when absent.
 * @param now - Current epoch milliseconds, injectable for deterministic tests.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!headerValue)
    return undefined

  const trimmed = headerValue.trim()
  if (trimmed.length === 0)
    return undefined

  // Delta-seconds form, for example "Retry-After: 120".
  if (/^\d+$/.test(trimmed))
    return Number(trimmed) * 1000

  // HTTP-date form, for example "Retry-After: Wed, 21 Oct 2026 07:28:00 GMT".
  const dateMs = Date.parse(trimmed)
  if (Number.isNaN(dateMs))
    return undefined

  return Math.max(0, dateMs - now)
}

/**
 * Computes a full-jitter exponential backoff delay.
 *
 * Full jitter picks a uniform random wait in `[0, min(maxDelayMs, baseDelayMs * 2^attempt)]`,
 * which spreads concurrent retries and avoids thundering-herd retry storms.
 *
 * Use when:
 * - {@link withRetry} needs the backoff for a given zero-based attempt index
 *
 * Expects:
 * - `attempt` is zero-based (0 for the first retry wait)
 *
 * Returns:
 * - An integer millisecond delay in `[0, cap]`
 */
export function computeFullJitterDelayMs(params: {
  attempt: number
  baseDelayMs: number
  maxDelayMs: number
  random?: () => number
}): number {
  const random = params.random ?? Math.random
  const exponential = params.baseDelayMs * (2 ** params.attempt)
  const cap = Math.min(params.maxDelayMs, exponential)
  return Math.floor(random() * cap)
}

/**
 * Runs an async function with capped exponential-backoff-with-full-jitter retries.
 *
 * Use when:
 * - A transient failure (rate limit, 5xx, network blip, timeout) should not abort a long run
 * - The caller can classify which errors are retryable and honor `Retry-After`
 *
 * Expects:
 * - `fn` performs one idempotent attempt and throws on failure
 * - `classify` returns retryable=false for permanent errors (4xx auth/validation, user abort)
 *
 * Returns:
 * - The first successful result, or rethrows the last error when attempts are exhausted or non-retryable
 *
 * Call stack:
 *
 * callAgentText (../agent-runtime)
 *   -> {@link withRetry}
 *     -> fn (one provider request -> text)
 *     -> {@link computeFullJitterDelayMs}
 */
export async function withRetry<T>(fn: () => Promise<T>, options: WithRetryOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts))
  let lastError: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn()
    }
    catch (error) {
      lastError = error
      const decision = options.classify(error)
      const isLastAttempt = attempt >= maxAttempts - 1
      if (!decision.retryable || isLastAttempt)
        throw error

      const backoff = computeFullJitterDelayMs({
        attempt,
        baseDelayMs: options.baseDelayMs,
        maxDelayMs: options.maxDelayMs,
        random,
      })
      // Retry-After is a floor: never retry sooner than the provider asked.
      await sleep(Math.max(decision.retryAfterMs ?? 0, backoff))
    }
  }

  throw lastError
}
