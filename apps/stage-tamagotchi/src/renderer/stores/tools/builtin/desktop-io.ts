import type { Tool } from '@xsai/shared-chat'

import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { tool } from '@xsai/tool'
import { z } from 'zod'

import {
  electronClipboardRead,
  electronClipboardWrite,
  electronScreenshotCapture,
} from '../../../../shared/eventa'

function createInvokers() {
  const { context } = createContext(window.electron.ipcRenderer)
  return {
    clipboardRead: defineInvoke(context, electronClipboardRead),
    clipboardWrite: defineInvoke(context, electronClipboardWrite),
    screenshot: defineInvoke(context, electronScreenshotCapture),
  }
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
    description: 'Capture the user\'s primary screen and save it as a PNG. Returns the saved file path; use file_read or describe it to the user. Use when the user asks about what is on their screen.',
    execute: async () => {
      const result = await getInvokers().screenshot()
      if (result.error) {
        return `Error: ${result.error}`
      }
      return JSON.stringify({ path: result.path, width: result.width, height: result.height })
    },
    parameters: z.object({}),
  }),
]

export const desktopIoTools = async () => Promise.all(tools)
