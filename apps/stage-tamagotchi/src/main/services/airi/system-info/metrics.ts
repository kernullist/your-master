/**
 * Pure system-metric helpers. Kept free of `electron` imports so they stay
 * unit-testable in plain Node.
 */

/** Per-core CPU time buckets, matching the shape of `os.cpus()[n].times`. */
export interface CpuTimes {
  user: number
  nice: number
  sys: number
  idle: number
  irq: number
}

/**
 * Aggregates a CPU-times snapshot into total and idle tick sums.
 *
 * Use when:
 * - Comparing two snapshots taken a short interval apart to derive busy %.
 *
 * Returns:
 * - `{ idle, total }` summed across all cores.
 */
export function sumCpuTimes(cores: { times: CpuTimes }[]): { idle: number, total: number } {
  let idle = 0
  let total = 0
  for (const core of cores) {
    const t = core.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

/**
 * Computes aggregate CPU busy percentage between two snapshots.
 *
 * Before:
 * - prev/curr from two `os.cpus()` reads ~100ms apart
 *
 * After:
 * - 0-100 number; 0 when no time elapsed (avoids divide-by-zero)
 *
 * Returns:
 * - Busy percentage rounded to one decimal, clamped to [0, 100].
 */
export function computeCpuUsagePercent(
  prev: { times: CpuTimes }[],
  curr: { times: CpuTimes }[],
): number {
  const before = sumCpuTimes(prev)
  const after = sumCpuTimes(curr)

  const totalDelta = after.total - before.total
  const idleDelta = after.idle - before.idle
  if (totalDelta <= 0) {
    return 0
  }

  const busy = (1 - idleDelta / totalDelta) * 100
  return Math.max(0, Math.min(100, Math.round(busy * 10) / 10))
}

/**
 * Memory used percentage from total/free bytes.
 *
 * Returns 0 when total is non-positive (avoids divide-by-zero).
 */
export function memoryUsedPercent(totalBytes: number, freeBytes: number): number {
  if (totalBytes <= 0) {
    return 0
  }
  const used = (1 - freeBytes / totalBytes) * 100
  return Math.max(0, Math.min(100, Math.round(used * 10) / 10))
}
