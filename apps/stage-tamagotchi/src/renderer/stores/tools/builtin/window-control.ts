import type { Tool } from '@xsai/shared-chat'

import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { tool } from '@xsai/tool'
import { z } from 'zod'

import { electronOsWindowClose, electronOsWindowFocus, electronOsWindowList } from '../../../../shared/eventa'

function createInvokers() {
  const { context } = createContext(window.electron.ipcRenderer)
  return {
    listWindows: defineInvoke(context, electronOsWindowList),
    focusWindow: defineInvoke(context, electronOsWindowFocus),
    closeWindow: defineInvoke(context, electronOsWindowClose),
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
    name: 'list_windows',
    description: 'List the open application windows on the user\'s screen (process name and title). Use to see what is open or to find a window before focusing or closing it.',
    execute: async () => {
      const result = await getInvokers().listWindows()
      if (result.error) {
        return `Error: ${result.error}`
      }
      return JSON.stringify(result.windows ?? [])
    },
    parameters: z.object({}),
  }),
  tool({
    name: 'focus_window',
    description: 'Bring an open window to the foreground (and un-minimize it) by a substring of its title. Use to switch the user to an app. Matches the first window whose title contains the text.',
    execute: async ({ match }) => {
      const result = await getInvokers().focusWindow({ match })
      return result.ok ? `OK: ${result.message}` : `Failed: ${result.message}`
    },
    parameters: z.object({
      match: z.string().describe('A substring of the target window title, e.g. "Notepad"'),
    }),
  }),
  tool({
    name: 'close_window',
    description: 'Close an open window by a substring of its title. THE USER MUST APPROVE this in a system dialog and may deny it — if denied, accept it and do not retry. The app closes gracefully and may prompt to save unsaved work.',
    execute: async ({ match }) => {
      const result = await getInvokers().closeWindow({ match })
      return result.ok ? `OK: ${result.message}` : `Rejected: ${result.message}`
    },
    parameters: z.object({
      match: z.string().describe('A substring of the target window title'),
    }),
  }),
]

export const windowControlTools = async () => Promise.all(tools)
