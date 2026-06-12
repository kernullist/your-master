import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type { ElectronSystemInfo } from '../../../../shared/eventa'

import { arch, cpus, freemem, hostname, platform, release, totalmem, uptime } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

import { defineInvokeHandler } from '@moeru/eventa'

import { electronSystemInfo } from '../../../../shared/eventa'
import { computeCpuUsagePercent, memoryUsedPercent } from './metrics'

/** CPU sampling window; long enough to be meaningful, short enough to feel instant. */
const CPU_SAMPLE_INTERVAL_MS = 120

/**
 * Read-only system metrics service (CPU/memory/OS). No approval gate — it
 * exposes no destructive capability.
 *
 * Call stack:
 *
 * main/index.ts -> setupDesktopAssistantServices
 *   -> {@link createSystemInfoService}
 *     -> {@link electronSystemInfo}
 *       -> {@link computeCpuUsagePercent} / {@link memoryUsedPercent}
 */
export function createSystemInfoService(params: {
  context: ReturnType<typeof createContext>['context']
}) {
  defineInvokeHandler(params.context, electronSystemInfo, async (): Promise<ElectronSystemInfo> => {
    // Two CPU snapshots a short interval apart give an aggregate busy %.
    const before = cpus()
    await delay(CPU_SAMPLE_INTERVAL_MS)
    const after = cpus()

    const total = totalmem()
    const free = freemem()

    return {
      platform: platform(),
      release: release(),
      arch: arch(),
      hostname: hostname(),
      uptimeSec: Math.round(uptime()),
      cpuModel: before[0]?.model?.trim() ?? 'unknown',
      cpuCount: before.length,
      cpuUsagePercent: computeCpuUsagePercent(before, after),
      memTotalBytes: total,
      memFreeBytes: free,
      memUsedPercent: memoryUsedPercent(total, free),
    }
  })
}
