import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type {
  ElectronFileFreeAccessMutationResult,
  ElectronFileFreeAccessPathsResult,
  ElectronFileListResult,
  ElectronFileReadResult,
  ElectronFileWriteResult,
} from '../../../../shared/eventa'

import { Buffer } from 'node:buffer'
import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { BrowserWindow, dialog } from 'electron'

import {
  electronFilesAddFreeAccessPath,
  electronFilesEdit,
  electronFilesGetFreeAccessPaths,
  electronFilesList,
  electronFilesRead,
  electronFilesRemoveFreeAccessPath,
  electronFilesSearch,
  electronFilesWrite,
} from '../../../../shared/eventa'
import { createFreeAccessStore } from './free-access-store'
import {
  applyStringEdit,
  buildLineDiff,
  buildWritePreview,
  FILE_LIST_MAX_ENTRIES,
  FILE_READ_MAX_BYTES,
  isPathWithinRoots,
  isProbablyBinary,
  validateFreeAccessPath,
  validateRequestPath,
  writeBlockReason,
} from './policy'
import {
  findContentMatches,
  isSearchableTextFile,
  matchesName,
  SEARCH_MAX_DEPTH,
  SEARCH_MAX_FILE_BYTES,
  SEARCH_MAX_FILES_VISITED,
  SEARCH_MAX_MATCHES,
  shouldSkipDirectory,
  validateSearchQuery,
} from './search'

/**
 * Local file access service: free reads/lists, user-approved writes unless the
 * target sits under a Settings-registered free-access path.
 *
 * Every write outside free-access roots shows a native dialog on the owning
 * window with the target path and a content preview; the default button is
 * "deny" so an accidental Enter never approves a modification. Free-access
 * paths skip the dialog but still keep a `.airi-bak` backup and still honor
 * the OS/program write blocklist.
 *
 * Call stack:
 *
 * setupMainWindowElectronInvokes / setupChatWindowElectronInvokes (../../../windows)
 *   -> {@link createFileAccessService}
 *     -> {@link electronFilesRead} / {@link electronFilesList} / {@link electronFilesWrite}
 *       -> policy checks ({@link validateRequestPath}, {@link writeBlockReason}, free-access roots)
 *         -> dialog.showMessageBox (writes outside free-access only)
 */
export function createFileAccessService(params: {
  context: ReturnType<typeof createContext>['context']
}) {
  const log = useLogg('main/file-access').useGlobalConfig()
  const freeAccess = createFreeAccessStore()

  /**
   * Resolves a path to its real on-disk location for the write blocklist check,
   * following symlinks/junctions. For a not-yet-existing target, the nearest
   * existing ancestor is realpath'd and the remaining segments re-appended.
   *
   * NOTICE:
   * writeBlockReason alone is a string-prefix check and is bypassable via
   * directory junctions/symlinks (e.g. C:\Users\me\sys -> C:\Windows\System32)
   * and 8.3 short names. Canonicalizing here closes those gaps before the
   * blocklist check. Falls back to the original path if realpath fails entirely.
   */
  async function resolveForBlockCheck(requestPath: string): Promise<string> {
    let current = requestPath
    const tail: string[] = []
    // Walk up until an existing ancestor is found; realpath that, then re-join.
    for (let depth = 0; depth < 64; depth += 1) {
      try {
        const real = await realpath(current)
        return tail.length ? join(real, ...tail.reverse()) : real
      }
      catch {
        const parent = dirname(current)
        if (parent === current) {
          return requestPath
        }
        tail.push(basename(current))
        current = parent
      }
    }
    return requestPath
  }

  /**
   * Whether a write/edit at `requestPath` may skip the approval dialog because
   * the real path (or nearest existing ancestor) sits under a free-access root.
   */
  async function isFreeAccessWrite(requestPath: string): Promise<boolean> {
    const roots = freeAccess.getPaths()
    if (roots.length === 0) {
      return false
    }

    const resolved = await resolveForBlockCheck(requestPath)
    return isPathWithinRoots(resolved, roots) || isPathWithinRoots(requestPath, roots)
  }

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

  /**
   * Writes content after optional user approval. Free-access targets skip the
   * dialog; everything else requires an explicit Approve click.
   */
  async function confirmAndWrite(requestPath: string, nextContent: string, exists: boolean, detail: string): Promise<ElectronFileWriteResult> {
    const free = await isFreeAccessWrite(requestPath)
    if (!free) {
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
    }

    try {
      // Keep a one-shot backup of the previous content so a mistaken
      // approval is recoverable without version control.
      if (exists) {
        await writeFile(`${requestPath}.airi-bak`, await readFile(requestPath))
      }

      await writeFile(requestPath, nextContent, 'utf-8')
      const bytes = Buffer.byteLength(nextContent, 'utf-8')
      log.withFields({ path: requestPath, bytes, freeAccess: free }).log(free ? 'file write free-access applied' : 'file write approved and applied')
      return {
        ok: true,
        message: free
          ? (exists
              ? `file updated without prompt (free-access path; backup saved as ${requestPath}.airi-bak)`
              : 'file created without prompt (free-access path)')
          : (exists
              ? `file updated (backup saved as ${requestPath}.airi-bak)`
              : 'file created'),
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

    const blocked = writeBlockReason(await resolveForBlockCheck(requestPath))
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

    const blocked = writeBlockReason(await resolveForBlockCheck(requestPath))
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

  defineInvokeHandler(params.context, electronFilesSearch, async (payload) => {
    const directory = payload?.directory ?? ''
    const query = payload?.query ?? ''
    const mode = payload?.mode === 'content' ? 'content' : 'name'

    const invalidPath = validateRequestPath(directory)
    if (invalidPath) {
      return { error: invalidPath }
    }
    const invalidQuery = validateSearchQuery(query)
    if (invalidQuery) {
      return { error: invalidQuery }
    }

    try {
      const info = await stat(directory)
      if (!info.isDirectory()) {
        return { error: `"${directory}" is not a directory` }
      }
    }
    catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }

    const matches: { path: string, line?: number, text?: string }[] = []
    let visited = 0
    let truncated = false

    // Iterative DFS with depth, visit-count, and match caps so a huge tree
    // can never hang the call. Skips noise/huge directories (node_modules, .git...).
    const stack: { dir: string, depth: number }[] = [{ dir: directory, depth: 0 }]
    while (stack.length > 0) {
      const { dir, depth } = stack.pop()!
      if (matches.length >= SEARCH_MAX_MATCHES || visited >= SEARCH_MAX_FILES_VISITED) {
        truncated = true
        break
      }

      let dirents
      try {
        dirents = await readdir(dir, { withFileTypes: true })
      }
      catch {
        // Unreadable dir (permissions) — skip it rather than failing the search.
        continue
      }

      for (const dirent of dirents) {
        if (matches.length >= SEARCH_MAX_MATCHES) {
          truncated = true
          break
        }

        const fullPath = join(dir, dirent.name)
        if (dirent.isDirectory()) {
          if (depth < SEARCH_MAX_DEPTH && !shouldSkipDirectory(dirent.name)) {
            stack.push({ dir: fullPath, depth: depth + 1 })
          }
          continue
        }

        if (!dirent.isFile()) {
          continue
        }

        visited += 1
        if (visited >= SEARCH_MAX_FILES_VISITED) {
          truncated = true
          break
        }

        if (mode === 'name') {
          if (matchesName(dirent.name, query)) {
            matches.push({ path: fullPath })
          }
          continue
        }

        // Content mode: only read plausibly-text files under the size cap.
        if (!isSearchableTextFile(dirent.name)) {
          continue
        }
        try {
          const fileInfo = await stat(fullPath)
          if (fileInfo.size > SEARCH_MAX_FILE_BYTES) {
            continue
          }
          const content = await readFile(fullPath, 'utf-8')
          const remaining = SEARCH_MAX_MATCHES - matches.length
          for (const hit of findContentMatches(content, query, remaining)) {
            matches.push({ path: fullPath, line: hit.line, text: hit.text })
          }
        }
        catch {
          // Unreadable/binary file — skip.
        }
      }
    }

    return { matches, truncated }
  })

  defineInvokeHandler(params.context, electronFilesGetFreeAccessPaths, async (): Promise<ElectronFileFreeAccessPathsResult> => {
    return { paths: freeAccess.getPaths() }
  })

  defineInvokeHandler(params.context, electronFilesAddFreeAccessPath, async (payload): Promise<ElectronFileFreeAccessMutationResult> => {
    let requestPath = payload?.path?.trim() ?? ''

    if (!requestPath) {
      const parent = BrowserWindow.getFocusedWindow() ?? undefined
      const picked = parent
        ? await dialog.showOpenDialog(parent, {
            title: 'Choose a free-access folder',
            properties: ['openDirectory', 'createDirectory'],
          })
        : await dialog.showOpenDialog({
            title: 'Choose a free-access folder',
            properties: ['openDirectory', 'createDirectory'],
          })

      if (picked.canceled || !picked.filePaths[0]) {
        return { ok: false, paths: freeAccess.getPaths(), message: 'folder selection canceled' }
      }
      requestPath = picked.filePaths[0]
    }

    const invalid = validateFreeAccessPath(requestPath)
    if (invalid) {
      return { ok: false, paths: freeAccess.getPaths(), message: invalid }
    }

    // Prefer the real path so junctions cannot expand free-write beyond intent.
    let resolvedPath = requestPath
    try {
      resolvedPath = await realpath(requestPath)
    }
    catch {
      // Not-yet-existing paths can still be registered from manual entry.
      resolvedPath = requestPath
    }

    const blocked = writeBlockReason(resolvedPath)
    if (blocked) {
      return { ok: false, paths: freeAccess.getPaths(), message: blocked }
    }

    try {
      const info = await stat(resolvedPath)
      if (!info.isDirectory() && !info.isFile()) {
        return { ok: false, paths: freeAccess.getPaths(), message: 'path must be a file or directory' }
      }
    }
    catch {
      return { ok: false, paths: freeAccess.getPaths(), message: `path does not exist: ${resolvedPath}` }
    }

    const result = freeAccess.addPath(resolvedPath)
    if (result.ok) {
      log.withFields({ path: result.path ?? resolvedPath }).log('free-access path registered')
    }
    return result
  })

  defineInvokeHandler(params.context, electronFilesRemoveFreeAccessPath, async (payload): Promise<ElectronFileFreeAccessMutationResult> => {
    const requestPath = payload?.path ?? ''
    const result = freeAccess.removePath(requestPath)
    if (result.ok) {
      log.withFields({ path: requestPath }).log('free-access path removed')
    }
    return result
  })
}
