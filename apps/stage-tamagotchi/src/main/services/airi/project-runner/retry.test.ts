import { describe, expect, it, vi } from 'vitest'

import {
  computeFullJitterDelayMs,
  isRetryableHttpStatus,
  parseRetryAfterMs,
  withRetry,
} from './retry'

describe('retry utilities', () => {
  it('marks only transient HTTP statuses as retryable', () => {
    expect(isRetryableHttpStatus(408)).toBe(true)
    expect(isRetryableHttpStatus(429)).toBe(true)
    expect(isRetryableHttpStatus(500)).toBe(true)
    expect(isRetryableHttpStatus(502)).toBe(true)
    expect(isRetryableHttpStatus(503)).toBe(true)
    expect(isRetryableHttpStatus(504)).toBe(true)
    expect(isRetryableHttpStatus(529)).toBe(true)
    expect(isRetryableHttpStatus(400)).toBe(false)
    expect(isRetryableHttpStatus(401)).toBe(false)
    expect(isRetryableHttpStatus(404)).toBe(false)
    expect(isRetryableHttpStatus(422)).toBe(false)
  })

  it('parses Retry-After delta-seconds and HTTP-date forms', () => {
    expect(parseRetryAfterMs('120')).toBe(120000)
    expect(parseRetryAfterMs('  30 ')).toBe(30000)
    expect(parseRetryAfterMs(null)).toBeUndefined()
    expect(parseRetryAfterMs(undefined)).toBeUndefined()
    expect(parseRetryAfterMs('')).toBeUndefined()
    expect(parseRetryAfterMs('not-a-date')).toBeUndefined()

    const now = Date.parse('2026-07-06T00:00:00.000Z')
    expect(parseRetryAfterMs('Mon, 06 Jul 2026 00:00:10 GMT', now)).toBe(10000)
    // A past HTTP-date clamps to zero instead of returning a negative wait.
    expect(parseRetryAfterMs('Mon, 06 Jul 2026 00:00:00 GMT', now + 5000)).toBe(0)
  })

  it('computes full-jitter backoff bounded by the exponential cap', () => {
    // random()=1 yields the full capped delay; random()=0 yields zero.
    expect(computeFullJitterDelayMs({ attempt: 0, baseDelayMs: 500, maxDelayMs: 30000, random: () => 1 })).toBe(500)
    expect(computeFullJitterDelayMs({ attempt: 0, baseDelayMs: 500, maxDelayMs: 30000, random: () => 0 })).toBe(0)
    expect(computeFullJitterDelayMs({ attempt: 2, baseDelayMs: 500, maxDelayMs: 30000, random: () => 0.5 })).toBe(1000)
    expect(computeFullJitterDelayMs({ attempt: 3, baseDelayMs: 500, maxDelayMs: 30000, random: () => 1 })).toBe(4000)
    // Attempt 10 exponential (512000ms) is clamped to the 30s cap.
    expect(computeFullJitterDelayMs({ attempt: 10, baseDelayMs: 500, maxDelayMs: 30000, random: () => 1 })).toBe(30000)
  })

  it('returns the first successful result without sleeping', async () => {
    const fn = vi.fn(async () => 'ok')
    const sleep = vi.fn(async () => {})

    const result = await withRetry(fn, {
      maxAttempts: 4,
      baseDelayMs: 500,
      maxDelayMs: 30000,
      classify: () => ({ retryable: true }),
      sleep,
      random: () => 0,
    })

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries retryable failures then succeeds', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls += 1
      if (calls < 3)
        throw new Error('boom')
      return 'ok'
    })
    const sleep = vi.fn(async () => {})

    const result = await withRetry(fn, {
      maxAttempts: 4,
      baseDelayMs: 500,
      maxDelayMs: 30000,
      classify: () => ({ retryable: true }),
      sleep,
      random: () => 0,
    })

    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('does not retry a non-retryable failure', async () => {
    const fn = vi.fn(async () => {
      throw new Error('permanent')
    })
    const sleep = vi.fn(async () => {})

    await expect(withRetry(fn, {
      maxAttempts: 4,
      baseDelayMs: 500,
      maxDelayMs: 30000,
      classify: () => ({ retryable: false }),
      sleep,
    })).rejects.toThrow('permanent')

    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('stops after maxAttempts and rethrows the last error', async () => {
    const fn = vi.fn(async () => {
      throw new Error('still failing')
    })
    const sleep = vi.fn(async () => {})

    await expect(withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 30000,
      classify: () => ({ retryable: true }),
      sleep,
      random: () => 0,
    })).rejects.toThrow('still failing')

    expect(fn).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('honors Retry-After as a floor over jittered backoff', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls += 1
      if (calls < 2)
        throw new Error('rate limited')
      return 'ok'
    })
    const sleep = vi.fn(async () => {})

    // random()=0 makes the jitter component zero, so the Retry-After floor dominates the wait.
    await withRetry(fn, {
      maxAttempts: 4,
      baseDelayMs: 500,
      maxDelayMs: 30000,
      classify: () => ({ retryable: true, retryAfterMs: 7000 }),
      sleep,
      random: () => 0,
    })

    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(7000)
  })
})
