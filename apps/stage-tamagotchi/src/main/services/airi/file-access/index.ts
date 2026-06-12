import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type {
  ElectronFileListResult,
  ElectronFileReadResult,
  ElectronFileWriteResult,
} from '../../../../shared/eventa'

import { Buffer } from 'node:buffer'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { BrowserWindow, dialog } from 'electron'

import {
  electronFilesEdit,
  electronFilesList,
  electronFilesRead,
  electronFilesWrite,
} from '../../../../shared/eventa'
import {
  applyStringEdit,
  buildLineDiff,
  buildWritePreview,
  FILE_LIST_MAX_ENTRIES,
  FILE_READ_MAX_BYTES,
  isProbablyBinary,
  validateRequestPath,
  writeBlockReason,
} from './policy'

/**
 * Local file access service: free reads/lists, user-approved writes.
 *
 * Every write shows a native dialog on the owning window with the target
 * path and a content preview; the default button is "deny" so an accidental
 * Enter never approves a modification.
 *
 * Call stack:
 *
 * setupMainWindowElectronInvokes / setupChatWindowElectronInvokes (../../../windows)
 *   -> {@link createFileAccessService}
 *     -> {@link electronFilesRead} / {@link electronFilesList} / {@link electronFilesWrite}
 *       -> policy checks ({@link validateRequestPath}, {@link writeBlockReason})
 *         -> dialog.showMessageBox (writes only)
 */
export function createFileAccessService(params: {
  context: ReturnType<typeof createContext>['context']
}) {
  const log = useLogg('main/file-access').useGlobalConfig()

  defineInvokeHandler(params.context, electronFilesRead, async (payload): Promise<ElectronFileReadResult> => {
    const requestPath = payload?.path ?? ''
    const invalid = validateRequestPath(requestPath)
    if (invalid) {
      return { error: invalid }
    }

    try {
      const info = await stat(requestPath)
      if (info.isDirectory()) {
        return { error: `"${requestPath}" is a directory; use file_list instead` }
      }

      const buffer = await readFile(requestPath)
      if (isProbablyBinary(buffer)) {
        return { error: `"${requestPath}" looks like a binary file and cannot be read as text`, size: info.size }
      }

      const truncated = buffer.length > FILE_READ_MAX_BYTES
      const content = buffer.subarray(0, FILE_READ_MAX_BYTES).toString('utf-8')
      log.withFields({ path: requestPath, size: info.size, truncated }).log('file read')
      return { content, truncated, size: info.size }
    }
    catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  defineInvokeHandler(params.context, electronFilesList, async (payload): Promise<ElectronFileListResult> => {
    const requestPath = payload?.path ?? ''
    const invalid = validateRequestPath(requestPath)
    if (invalid) {
      return { error: invalid }
    }

    try {
      const dirents = await readdir(requestPath, { withFileTypes: true })
      const truncated = dirents.length > FILE_LIST_MAX_ENTRIES
      const limited = dirents.slice(0, FILE_LIST_MAX_ENTRIES)

      const entries = await Promise.all(limited.map(async (dirent) => {
        if (dirent.isDirectory()) {
          return { name: dirent.name, type: 'directory' as const }
        }

        try {
          const info = await stat(join(requestPath, dirent.name))
          return { name: dirent.name, type: 'file' as const, size: info.size }
        }
        catch {
          return { name: dirent.name, type: 'file' as const }
        }
      }))

      return { entries, truncated }
    }
    catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Shared approval + backup + write path for both full writes and edits.
  // `detail` is the dialog body (content preview or diff). Returns the tool
  // result; nothing is written unless the user explicitly approves.
  async function confirmAndWrite(requestPath: string, nextContent: string, exists: boolean, detail: string): Promise<ElectronFileWriteResult> {
    const parent = BrowserWindow.getFocusedWindow() ?? undefined
    const dialogOptions = {
      type: 'warning' as const,
      title: 'AIRI file modification request',
      message: `AIRI wants to modify a file:\n${requestPath}`,
      detail,
      buttons: ['Deny', 'Approve'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    const choice = parent
      ? await dialog.showMessageBox(parent, dialogOptions)
      : await dialog.showMessageBox(dialogOptions)

    if (choice.response !== 1) {
      log.withFields({ path: requestPath }).log('file write denied by user')
      return { ok: false, message: 'user denied the modification' }
    }

    try {
      // Keep a one-shot backup of the previous content so a mistaken
      // approval is recoverable without version control.
      if (exists) {
        await writeFile(`${requestPath}.airi-bak`, await readFile(requestPath))
      }

      await writeFile(requestPath, nextContent, 'utf-8')
      log.withFields({ path: requestPath, bytes: Buffer.byteLength(nextContent, 'utf-8') }).log('file write approved and applied')
      return {
        ok: true,
        message: exists
          ? `file updated (backup saved as ${requestPath}.airi-bak)`
          : 'file created',
      }
    }
    catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  defineInvokeHandler(params.context, electronFilesWrite, async (payload): Promise<ElectronFileWriteResult> => {
    const requestPath = payload?.path ?? ''
    const content = payload?.content ?? ''

    const invalid = validateRequestPath(requestPath)
    if (invalid) {
      return { ok: false, message: invalid }
    }

    const blocked = writeBlockReason(requestPath)
    if (blocked) {
      return { ok: false, message: blocked }
    }

    let exists = false
    let previousSize = 0
    try {
      const info = await stat(requestPath)
      if (info.isDirectory()) {
        return { ok: false, message: `"${requestPath}" is a directory` }
      }
      exists = true
      previousSize = info.size
    }
    catch {
      // New file; ensure the parent directory exists before asking the user.
      try {
        await stat(dirname(requestPath))
      }
      catch {
        return { ok: false, message: `parent directory of "${requestPath}" does not exist` }
      }
    }

    const summary = exists
      ? `Overwrite existing file (${previousSize} bytes -> ${Buffer.byteLength(content, 'utf-8')} bytes)`
      : `Create new file (${Buffer.byteLength(content, 'utf-8')} bytes)`

    return confirmAndWrite(requestPath, content, exists, `${summary}\n\n--- content preview ---\n${buildWritePreview(content)}`)
  })

  defineInvokeHandler(params.context, electronFilesEdit, async (payload): Promise<ElectronFileWriteResult> => {
    const requestPath = payload?.path ?? ''
    const oldString = payload?.oldString ?? ''
    const newString = payload?.newString ?? ''

    const invalid = validateRequestPath(requestPath)
    if (invalid) {
      return { ok: false, message: invalid }
    }

    const blocked = writeBlockReason(requestPath)
    if (blocked) {
      return { ok: false, message: blocked }
    }

    let current: string
    try {
      const info = await stat(requestPath)
      if (info.isDirectory()) {
        return { ok: false, message: `"${requestPath}" is a directory` }
      }
      const buffer = await readFile(requestPath)
      if (isProbablyBinary(buffer)) {
        return { ok: false, message: `"${requestPath}" looks like a binary file and cannot be edited as text` }
      }
      current = buffer.toString('utf-8')
    }
    catch (error) {
      return { ok: false, message: `cannot edit: ${error instanceof Error ? error.message : String(error)}` }
    }

    const edited = applyStringEdit(current, oldString, newString)
    if (!edited.ok || edited.result == null) {
      return { ok: false, message: edited.error ?? 'edit failed' }
    }

    // The dialog shows a diff so the user sees exactly what changes.
    return confirmAndWrite(requestPath, edited.result, true, `Edit existing file:\n\n--- diff ---\n${buildLineDiff(current, edited.result)}`)
  })
}
