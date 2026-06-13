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
  // NOTICE:
  // Windows strips trailing dots and spaces from each path component at the
  // filesystem layer, so "C:\Windows.\System32\x" and "C:\Windows \..." resolve
  // into the real C:\Windows, but node:path.normalize preserves them verbatim —
  // a prefix-only check would be bypassed. Strip per-component trailing dots/
  // spaces before comparing. (Symlink/junction and 8.3-shortname evasion are
  // still possible; this denylist is a best-effort guard behind the approval
  // dialog, not a hard boundary.)
  const stripped = normalize(absolutePath)
    .split(/[/\\]/)
    .map(segment => segment.replace(/[.\s]+$/, ''))
    .join('\\')
    .toLowerCase()

  const blocked = WRITE_BLOCKED_PREFIXES.find(prefix => stripped.startsWith(prefix))
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

/** Max diff lines shown in the approval dialog before truncation. */
export const DIFF_PREVIEW_MAX_LINES = 60

/** Outcome of {@link applyStringEdit}. */
export interface StringEditResult {
  ok: boolean
  result?: string
  error?: string
}

/**
 * Applies a single exact-match string replacement, requiring the target to be
 * unique (same contract as a typical code-edit tool).
 *
 * Use when:
 * - Performing a partial file edit without rewriting the whole file.
 *
 * Expects:
 * - `oldString` non-empty and appearing exactly once in `content`;
 *   `newString` may be empty (deletion).
 *
 * Returns:
 * - `{ ok: true, result }` with the replaced content, or `{ ok: false, error }`
 *   when the target is empty, missing, or ambiguous.
 */
export function applyStringEdit(content: string, oldString: string, newString: string): StringEditResult {
  if (oldString === '') {
    return { ok: false, error: 'oldString is empty; use file_write to create or fully replace a file' }
  }

  if (oldString === newString) {
    return { ok: false, error: 'oldString and newString are identical; nothing to change' }
  }

  const firstIndex = content.indexOf(oldString)
  if (firstIndex === -1) {
    return { ok: false, error: 'oldString was not found in the file' }
  }

  const lastIndex = content.lastIndexOf(oldString)
  if (firstIndex !== lastIndex) {
    return { ok: false, error: 'oldString matches multiple locations; include more surrounding context to make it unique' }
  }

  return { ok: true, result: `${content.slice(0, firstIndex)}${newString}${content.slice(firstIndex + oldString.length)}` }
}

/**
 * Builds a compact line-level diff for an approval dialog.
 *
 * Before:
 * - before = "a\nb\nc", after = "a\nB\nc"
 *
 * After:
 * - "  a\n- b\n+ B\n  c"
 *
 * Uses an LCS over lines so unchanged lines are shown as context and changed
 * regions as `-`/`+`. Output is capped at {@link DIFF_PREVIEW_MAX_LINES}.
 */
export function buildLineDiff(before: string, after: string): string {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const rows = beforeLines.length
  const cols = afterLines.length

  // LCS length table.
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => Array.from<number>({ length: cols + 1 }).fill(0))
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lcs[i][j] = beforeLines[i] === afterLines[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const out: string[] = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (beforeLines[i] === afterLines[j]) {
      out.push(`  ${beforeLines[i]}`)
      i += 1
      j += 1
    }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${beforeLines[i]}`)
      i += 1
    }
    else {
      out.push(`+ ${afterLines[j]}`)
      j += 1
    }
  }
  while (i < rows) {
    out.push(`- ${beforeLines[i]}`)
    i += 1
  }
  while (j < cols) {
    out.push(`+ ${afterLines[j]}`)
    j += 1
  }

  if (out.length > DIFF_PREVIEW_MAX_LINES) {
    const shown = out.slice(0, DIFF_PREVIEW_MAX_LINES)
    return `${shown.join('\n')}\n... (${out.length - DIFF_PREVIEW_MAX_LINES} more diff lines)`
  }

  return out.join('\n')
}
