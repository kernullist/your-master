import type { Tool } from '@xsai/shared-chat'

import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { tool } from '@xsai/tool'
import { z } from 'zod'

import { electronFilesList, electronFilesRead, electronFilesWrite } from '../../../../shared/eventa'

function createInvokers() {
  const { context } = createContext(window.electron.ipcRenderer)
  return {
    readFile: defineInvoke(context, electronFilesRead),
    listDirectory: defineInvoke(context, electronFilesList),
    writeFile: defineInvoke(context, electronFilesWrite),
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
    name: 'file_read',
    description: 'Read a text file from the user\'s computer by absolute path. Returns UTF-8 content (truncated past 512KB). Fails on binary files and directories.',
    execute: async ({ path }) => {
      const result = await getInvokers().readFile({ path })
      if (result.error) {
        return `Error: ${result.error}`
      }
      return JSON.stringify({ content: result.content, truncated: result.truncated ?? false, size: result.size })
    },
    parameters: z.object({
      path: z.string().describe('Absolute path of the file, e.g. C:\\Users\\me\\notes.txt'),
    }),
  }),
  tool({
    name: 'file_list',
    description: 'List the entries of a directory on the user\'s computer by absolute path. Returns names, types (file/directory) and file sizes.',
    execute: async ({ path }) => {
      const result = await getInvokers().listDirectory({ path })
      if (result.error) {
        return `Error: ${result.error}`
      }
      return JSON.stringify({ entries: result.entries, truncated: result.truncated ?? false })
    },
    parameters: z.object({
      path: z.string().describe('Absolute path of the directory, e.g. C:\\Users\\me\\Documents'),
    }),
  }),
  tool({
    name: 'file_write',
    description: 'Create or overwrite a text file on the user\'s computer. THE USER MUST APPROVE EVERY WRITE in a system dialog and may deny it — if denied, accept the decision and do not retry. Overwrites keep a .airi-bak backup.',
    execute: async ({ path, content }) => {
      const result = await getInvokers().writeFile({ path, content })
      return result.ok ? `OK: ${result.message}` : `Rejected: ${result.message}`
    },
    parameters: z.object({
      path: z.string().describe('Absolute path of the file to create or overwrite'),
      content: z.string().describe('Full new file content (UTF-8). Partial edits are not supported; provide the complete file.'),
    }),
  }),
]

export const fileAccessTools = async () => Promise.all(tools)
