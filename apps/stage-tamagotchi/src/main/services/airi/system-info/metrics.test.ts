import type { CpuTimes } from './metrics'

import { describe, expect, it } from 'vitest'

import { computeCpuUsagePercent, memoryUsedPercent, sumCpuTimes } from './metrics'

function core(times: Partial<CpuTimes>): { times: CpuTimes } {
  return { times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0, ...times } }
}

describe('sumCpuTimes', () => {
  it('sums idle and total across cores', () => {
    const result = sumCpuTimes([
      core({ user: 10, sys: 5, idle: 85 }),
      core({ user: 20, sys: 10, idle: 70 }),
    ])
    expect(result.idle).toBe(155)
    expect(result.total).toBe(200)
  })
})

describe('computeCpuUsagePercent', () => {
  it('returns 0 when no time elapsed (divide-by-zero guard)', () => {
    const snap = [core({ user: 10, idle: 90 })]
    expect(computeCpuUsagePercent(snap, snap)).toBe(0)
  })

  it('computes busy percentage from idle delta', () => {
    // 100 total ticks elapsed, 70 of them idle -> 30% busy.
    const prev = [core({ user: 0, idle: 0 })]
    const curr = [core({ user: 30, idle: 70 })]
    expect(computeCpuUsagePercent(prev, curr)).toBe(30)
  })

  it('reports near-100% when almost no idle time accrues', () => {
    const prev = [core({ user: 0, idle: 0 })]
    const curr = [core({ user: 99, idle: 1 })]
    expect(computeCpuUsagePercent(prev, curr)).toBe(99)
  })
})

describe('memoryUsedPercent', () => {
  it('computes used percentage', () => {
    expect(memoryUsedPercent(16, 4)).toBe(75)
  })

  it('guards against zero total', () => {
    expect(memoryUsedPercent(0, 0)).toBe(0)
  })
})
