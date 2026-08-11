import type { Tool } from '@xsai/shared-chat'

import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { tool } from '@xsai/tool'
import { z } from 'zod'

import {
  electronFilesEdit,
  electronFilesGetFreeAccessPaths,
  electronFilesList,
  electronFilesRead,
  electronFilesSearch,
  electronFilesWrite,
} from '../../../../shared/eventa'

function createInvokers() {
  const { context } = createContext(window.electron.ipcRenderer)
  return {
    readFile: defineInvoke(context, electronFilesRead),
    listDirectory: defineInvoke(context, electronFilesList),
    writeFile: defineInvoke(context, electronFilesWrite),
    editFile: defineInvoke(context, electronFilesEdit),
    searchFiles: defineInvoke(context, electronFilesSearch),
    getFreeAccessPaths: defineInvoke(context, electronFilesGetFreeAccessPaths),
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

/**
 * Builds a short, model-facing note about registered free-access folders.
 *
 * Before:
 * - paths = ["F:\\notes", "D:\\work"]
 *
 * After:
 * - "Registered free-access folders (prefer these when the user does not give a path):\n- F:\\notes\n- D:\\work\n..."
 *
 * Use when:
 * - Injecting free-access roots into file tool descriptions so the model does
 *   not invent Desktop/Documents when the user only said "write a file".
 */
function buildFreeAccessGuidance(paths: readonly string[]): string {
  if (paths.length === 0) {
    return [
      'No free-access folders are registered in Settings → File access.',
      'When the user does not give an absolute path, ASK which folder to use before writing.',
      'Do not invent paths like Desktop, Documents, or C:\\temp.',
    ].join(' ')
  }

  const listed = paths.map(path => `- ${path}`).join('\n')
  const primary = paths[0]
  return [
    'Registered free-access folders (writes/edits here skip the approval dialog):',
    listed,
    `When the user asks to create or save a file but does NOT specify a path, write under the first free-access folder: ${primary}`,
    'Example: create "mood.md" at',
    `${primary}\\mood.md`,
    '(use the platform path separator). Prefer free-access folders over Desktop/Documents/home guesses.',
  ].join('\n')
}

/**
 * Loads the current free-access path list for tool description injection.
 *
 * Returns:
 * - Absolute paths from main-process persistence, or [] on IPC failure.
 */
async function loadFreeAccessPaths(): Promise<string[]> {
  try {
    const result = await getInvokers().getFreeAccessPaths()
    return result.paths ?? []
  }
  catch {
    return []
  }
}

/**
 * Builds the local file-access toolset with free-access path guidance baked
 * into descriptions (re-fetched each time tools are resolved).
 *
 * Use when:
 * - chat-sync assembles the enabled `files` tool category for a turn.
 *
 * Expects:
 * - Electron renderer with file-access IPC handlers registered.
 *
 * Returns:
 * - file_read / file_list / search_files / file_write / file_edit tools.
 */
export async function fileAccessTools(): Promise<Tool[]> {
  const freeAccessPaths = await loadFreeAccessPaths()
  const freeAccessGuidance = buildFreeAccessGuidance(freeAccessPaths)

  return Promise.all([
    tool({
      name: 'file_read',
      description: [
        'Read a text file from the user\'s computer by absolute path.',
        'Returns UTF-8 content (truncated past 512KB). Fails on binary files and directories.',
        freeAccessGuidance,
      ].join(' '),
      execute: async ({ path }) => {
        const result = await getInvokers().readFile({ path })
        if (result.error) {
          return `Error: ${result.error}`
        }
        return JSON.stringify({ content: result.content, truncated: result.truncated ?? false, size: result.size })
      },
      parameters: z.object({
        path: z.string().describe(
          freeAccessPaths[0]
            ? `Absolute path of the file, e.g. ${freeAccessPaths[0]}\\notes.txt`
            : 'Absolute path of the file, e.g. C:\\Users\\me\\notes.txt',
        ),
      }),
    }),
    tool({
      name: 'file_list',
      description: [
        'List the entries of a directory on the user\'s computer by absolute path.',
        'Returns names, types (file/directory) and file sizes.',
        freeAccessGuidance,
      ].join(' '),
      execute: async ({ path }) => {
        const result = await getInvokers().listDirectory({ path })
        if (result.error) {
          return `Error: ${result.error}`
        }
        return JSON.stringify({ entries: result.entries, truncated: result.truncated ?? false })
      },
      parameters: z.object({
        path: z.string().describe(
          freeAccessPaths[0]
            ? `Absolute path of the directory, e.g. ${freeAccessPaths[0]}`
            : 'Absolute path of the directory, e.g. C:\\Users\\me\\Documents',
        ),
      }),
    }),
    tool({
      name: 'file_write',
      description: [
        'Create or overwrite a text file on the user\'s computer with full content.',
        'Prefer file_edit for small changes to an existing file.',
        'Outside free-access folders the user must approve every write in a system dialog and may deny it — if denied, accept the decision and do not retry.',
        'Writes under a registered free-access path skip the dialog. Overwrites keep a .airi-bak backup.',
        freeAccessGuidance,
      ].join('\n'),
      execute: async ({ path, content }) => {
        const result = await getInvokers().writeFile({ path, content })
        return result.ok ? `OK: ${result.message}` : `Rejected: ${result.message}`
      },
      parameters: z.object({
        path: z.string().describe(
          freeAccessPaths[0]
            ? `Absolute path of the file to create or overwrite. If the user did not specify a folder, use ${freeAccessPaths[0]}\\<filename>`
            : 'Absolute path of the file to create or overwrite. If the user did not specify a path, ask them for one — do not invent Desktop/Documents.',
        ),
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
      description: [
        'Search a folder (recursively) for files by name or by text content.',
        'Use to answer "where is my ... file?" or "which file mentions ...".',
        'mode "name" matches the filename; mode "content" searches inside text files and returns matching lines. Read-only.',
        freeAccessGuidance,
      ].join(' '),
      execute: async ({ directory, query, mode }) => {
        const result = await getInvokers().searchFiles({ directory, query, mode })
        if (result.error) {
          return `Error: ${result.error}`
        }
        return JSON.stringify({ matches: result.matches ?? [], truncated: result.truncated ?? false })
      },
      parameters: z.object({
        directory: z.string().describe(
          freeAccessPaths[0]
            ? `Absolute path of the folder to search under. Prefer ${freeAccessPaths[0]} when the user is vague.`
            : 'Absolute path of the folder to search under, e.g. C:\\Users\\me\\Documents',
        ),
        query: z.string().describe('Text to look for (in filenames, or in file contents for content mode)'),
        mode: z.enum(['name', 'content']).optional().describe('"name" (default) matches filenames; "content" searches inside text files'),
      }),
    }),
    tool({
      name: 'file_edit',
      description: [
        'Make a partial edit to an existing text file by replacing an exact unique string.',
        'Outside free-access folders the user must approve the change in a system dialog showing a diff, and may deny it — if denied, accept the decision and do not retry.',
        'Edits under a registered free-access path skip the dialog.',
        'oldString must appear exactly once; include surrounding context to make it unique. Keeps a .airi-bak backup.',
        freeAccessGuidance,
      ].join('\n'),
      execute: async ({ path, oldString, newString }) => {
        const result = await getInvokers().editFile({ path, oldString, newString })
        return result.ok ? `OK: ${result.message}` : `Rejected: ${result.message}`
      },
      parameters: z.object({
        path: z.string().describe(
          freeAccessPaths[0]
            ? `Absolute path of the file to edit. Prefer files under free-access folders such as ${freeAccessPaths[0]}`
            : 'Absolute path of the file to edit',
        ),
        oldString: z.string().describe('The exact existing text to replace (must be unique in the file)'),
        newString: z.string().describe('The replacement text (may be empty to delete the matched text)'),
      }),
    }),
  ])
}

/** Pure helper exported for unit tests. */
export { buildFreeAccessGuidance }
