import type { Tool } from '@xsai/shared-chat'

import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { tool } from '@xsai/tool'
import { z } from 'zod'

import {
  electronClipboardRead,
  electronClipboardWrite,
  electronScreenshotCapture,
  electronSystemInfo,
} from '../../../../shared/eventa'

function createInvokers() {
  const { context } = createContext(window.electron.ipcRenderer)
  return {
    clipboardRead: defineInvoke(context, electronClipboardRead),
    clipboardWrite: defineInvoke(context, electronClipboardWrite),
    screenshot: defineInvoke(context, electronScreenshotCapture),
    systemInfo: defineInvoke(context, electronSystemInfo),
  }
}

/** Bytes -> GiB with one decimal, for human/model-readable memory figures. */
function toGiB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10
}

type Invokers = ReturnType<typeof createInvokers>
let invokeCache: Invokers | undefined

function getInvokers(): Invokers {
  if (!invokeCache) {
    invokeCache = createInvokers()
  }
  return invokeCache
}

const tools: Promise<Tool>[] = [
  tool({
    name: 'clipboard_read',
    description: 'Read the current text contents of the user\'s clipboard. Use when the user refers to "what I just copied".',
    execute: async () => {
      const result = await getInvokers().clipboardRead()
      return JSON.stringify({ text: result.text })
    },
    parameters: z.object({}),
  }),
  tool({
    name: 'clipboard_write',
    description: 'Replace the user\'s clipboard with the given text, so they can paste it elsewhere.',
    execute: async ({ text }) => {
      await getInvokers().clipboardWrite({ text })
      return 'OK: copied to clipboard'
    },
    parameters: z.object({
      text: z.string().describe('The text to place on the clipboard'),
    }),
  }),
  tool({
    name: 'screenshot',
    // strict:false because `window` is optional (xsai tool() defaults strict:true
    // without adding optional keys to required - rejected by strict providers).
    strict: false,
    description: 'Capture the screen and save it as a PNG. Pass `window` (a substring of a window title, e.g. "VMware", "Chrome") to capture just that one window instead of the whole screen; omit it to capture the full primary screen. If the window is not found, the result lists the open window titles so you can retry with a correct one. Returns the saved file path; describe it to the user. Use when the user asks about what is on their screen or in a specific app window.',
    execute: async ({ window }) => {
      const result = await getInvokers().screenshot(window ? { window } : undefined)
      if (result.error) {
        // Surface available titles so the model can immediately retry with a real window.
        const hint = result.availableWindows?.length ? ` Open windows: ${result.availableWindows.join(', ')}` : ''
        return `Error: ${result.error}.${hint}`
      }
      return JSON.stringify({
        path: result.path,
        width: result.width,
        height: result.height,
        source: result.source,
        matchedWindow: result.matchedWindow,
      })
    },
    parameters: z.object({
      window: z.string().optional().describe('Optional substring of a window title to capture only that window (e.g. "VMware"); omit for the full screen'),
    }),
  }),
  tool({
    name: 'system_info',
    description: 'Read the computer\'s current resource usage and OS info: CPU model/cores/usage %, memory total/free/used %, OS platform/version, hostname, uptime. Use when the user asks how their PC is doing, what is using resources, or for system specs. For a per-process list, use run_command with "tasklist".',
    execute: async () => {
      const info = await getInvokers().systemInfo()
      return JSON.stringify({
        os: `${info.platform} ${info.release} (${info.arch})`,
        hostname: info.hostname,
        uptimeHours: Math.round((info.uptimeSec / 3600) * 10) / 10,
        cpu: `${info.cpuModel} x${info.cpuCount}`,
        cpuUsagePercent: info.cpuUsagePercent,
        memoryTotalGiB: toGiB(info.memTotalBytes),
        memoryFreeGiB: toGiB(info.memFreeBytes),
        memoryUsedPercent: info.memUsedPercent,
      })
    },
    parameters: z.object({}),
  }),
]

export const desktopIoTools = async () => Promise.all(tools)
