import type { Tool } from '@xsai/shared-chat'

import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { tool } from '@xsai/tool'
import { z } from 'zod'

import { electronFilesEdit, electronFilesList, electronFilesRead, electronFilesSearch, electronFilesWrite } from '../../../../shared/eventa'

function createInvokers() {
  const { context } = createContext(window.electron.ipcRenderer)
  return {
    readFile: defineInvoke(context, electronFilesRead),
    listDirectory: defineInvoke(context, electronFilesList),
    writeFile: defineInvoke(context, electronFilesWrite),
    editFile: defineInvoke(context, electronFilesEdit),
    searchFiles: defineInvoke(context, electronFilesSearch),
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
    description: 'Create or overwrite a text file on the user\'s computer with full content. Prefer file_edit for small changes to an existing file. THE USER MUST APPROVE EVERY WRITE in a system dialog and may deny it — if denied, accept the decision and do not retry. Overwrites keep a .airi-bak backup.',
    execute: async ({ path, content }) => {
      const result = await getInvokers().writeFile({ path, content })
      return result.ok ? `OK: ${result.message}` : `Rejected: ${result.message}`
    },
    parameters: z.object({
      path: z.string().describe('Absolute path of the file to create or overwrite'),
      content: z.string().describe('Full new file content (UTF-8). For small changes to an existing file, use file_edit instead.'),
    }),
  }),
  tool({
    name: 'search_files',
    // NOTICE: strict:false because `mode` is optional. xsai tool() defaults
    // strict:true, which forces additionalProperties:false WITHOUT adding
    // optional keys to `required` — a schema OpenAI-strict providers reject.
    // Same approach as createFlattenedMcpTools.
    strict: false,
    description: 'Search a folder (recursively) for files by name or by text content. Use to answer "where is my ... file?" or "which file mentions ...". mode "name" matches the filename; mode "content" searches inside text files and returns matching lines. Read-only.',
    execute: async ({ directory, query, mode }) => {
      const result = await getInvokers().searchFiles({ directory, query, mode })
      if (result.error) {
        return `Error: ${result.error}`
      }
      return JSON.stringify({ matches: result.matches ?? [], truncated: result.truncated ?? false })
    },
    parameters: z.object({
      directory: z.string().describe('Absolute path of the folder to search under, e.g. C:\\Users\\me\\Documents'),
      query: z.string().describe('Text to look for (in filenames, or in file contents for content mode)'),
      mode: z.enum(['name', 'content']).optional().describe('"name" (default) matches filenames; "content" searches inside text files'),
    }),
  }),
  tool({
    name: 'file_edit',
    description: 'Make a partial edit to an existing text file by replacing an exact unique string. THE USER MUST APPROVE the change in a system dialog showing a diff, and may deny it — if denied, accept the decision and do not retry. oldString must appear exactly once; include surrounding context to make it unique. Keeps a .airi-bak backup.',
    execute: async ({ path, oldString, newString }) => {
      const result = await getInvokers().editFile({ path, oldString, newString })
      return result.ok ? `OK: ${result.message}` : `Rejected: ${result.message}`
    },
    parameters: z.object({
      path: z.string().describe('Absolute path of the file to edit'),
      oldString: z.string().describe('The exact existing text to replace (must be unique in the file)'),
      newString: z.string().describe('The replacement text (may be empty to delete the matched text)'),
    }),
  }),
]

export const fileAccessTools = async () => Promise.all(tools)
