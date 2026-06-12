/**
 * Pure policy helpers for the local file access tools. Kept free of
 * `electron` imports so they stay unit-testable in plain Node.
 */

import { isAbsolute, normalize } from 'node:path'

/**
 * Maximum bytes returned by a single read. Large-but-reasonable for source
 * files and documents; the model's context cannot use much more anyway.
 */
export const FILE_READ_MAX_BYTES = 512 * 1024

/** Maximum directory entries returned by a single list call. */
export const FILE_LIST_MAX_ENTRIES = 300

/** Maximum characters of new content shown inside the approval dialog. */
export const WRITE_PREVIEW_MAX_CHARS = 700

// NOTICE:
// Write-protected roots: an LLM-initiated write into OS or program
// directories is never what the user means by "modify my files", and a
// mis-approved dialog there could break the system. Reads stay allowed.
// Comparison is prefix-based on the normalized lower-case path.
const WRITE_BLOCKED_PREFIXES = [
  'c:\\windows',
  'c:\\program files',
  'c:\\program files (x86)',
  'c:\\programdata',
]

/**
 * Validates a path for any file operation.
 *
 * Use when:
 * - Sanitizing tool-supplied paths before touching the filesystem.
 *
 * Expects:
 * - Any string from the model; relative paths are rejected because the main
 *   process cwd is meaningless to the user.
 *
 * Returns:
 * - An error message, or undefined when the path is acceptable.
 */
export function validateRequestPath(rawPath: string): string | undefined {
  const trimmed = rawPath?.trim()
  if (!trimmed) {
    return 'path is required'
  }

  if (!isAbsolute(trimmed)) {
    return `path must be absolute (got "${trimmed}")`
  }

  // UNC shares are out of scope: approval semantics on remote shares are
  // unclear and accidental writes are harder to undo.
  if (trimmed.startsWith('\\\\')) {
    return 'UNC network paths are not supported'
  }

  return undefined
}

/**
 * Checks whether writes into the given path are categorically blocked.
 *
 * Use when:
 * - Deciding whether to even show the user an approval dialog.
 *
 * Expects:
 * - An absolute Windows path (validated by {@link validateRequestPath}).
 *
 * Returns:
 * - An error message naming the blocked root, or undefined when writable.
 */
export function writeBlockReason(absolutePath: string): string | undefined {
  const normalized = normalize(absolutePath).toLowerCase()
  const blocked = WRITE_BLOCKED_PREFIXES.find(prefix => normalized.startsWith(prefix))
  if (blocked) {
    return `writes under "${blocked}" are blocked for safety`
  }

  return undefined
}

/**
 * Heuristically detects binary content.
 *
 * Before:
 * - Buffer of a PNG/EXE (contains NUL bytes early)
 *
 * After:
 * - true (binary), while UTF-8 source/text returns false
 */
export function isProbablyBinary(buffer: Uint8Array): boolean {
  const sampleLength = Math.min(buffer.length, 8192)
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) {
      return true
    }
  }

  return false
}

/**
 * Normalizes write content into the short preview shown in the approval
 * dialog.
 *
 * Before:
 * - 50 KB of file content
 *
 * After:
 * - First {@link WRITE_PREVIEW_MAX_CHARS} characters plus a truncation note
 */
export function buildWritePreview(content: string): string {
  if (content.length <= WRITE_PREVIEW_MAX_CHARS) {
    return content
  }

  return `${content.slice(0, WRITE_PREVIEW_MAX_CHARS)}\n... (${content.length - WRITE_PREVIEW_MAX_CHARS} more characters)`
}
