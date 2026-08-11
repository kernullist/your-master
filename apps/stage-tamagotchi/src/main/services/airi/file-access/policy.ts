/**
 * Pure policy helpers for the local file access tools. Kept free of
 * `electron` imports so they stay unit-testable in plain Node.
 */

import { isAbsolute, normalize, sep } from 'node:path'

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
/**
 * Canonicalizes an absolute path for containment / denylist comparisons.
 *
 * Before:
 * - "C:\\Users\\me\\Projects\\..\\Notes\\"
 * - "C:\\Windows.\\System32\\x"
 *
 * After (win32):
 * - "c:\\users\\me\\notes"
 * - "c:\\windows\\system32\\x"
 *
 * NOTICE:
 * Windows strips trailing dots and spaces from each path component at the
 * filesystem layer, so "C:\Windows.\System32\x" and "C:\Windows \..." resolve
 * into the real C:\Windows, but node:path.normalize preserves them verbatim —
 * a prefix-only check would be bypassed. Strip per-component trailing dots/
 * spaces before comparing. (Symlink/junction and 8.3-shortname evasion are
 * still possible at this layer; callers that need a hard boundary should also
 * realpath the target.)
 */
export function normalizePathKey(absolutePath: string): string {
  const isWin = process.platform === 'win32'
  let normalized = normalize(absolutePath)

  if (isWin) {
    normalized = normalized
      .split(/[/\\]/)
      .map(segment => segment.replace(/[.\s]+$/, ''))
      .join('\\')
      .toLowerCase()
  }

  // Drop a trailing separator so "C:\foo\" and "C:\foo" compare equal, but keep
  // drive/root forms like "C:\" (length 3 on Windows) and "/".
  if (normalized.length > 1 && (normalized.endsWith('\\') || normalized.endsWith('/'))) {
    const withoutTrailing = normalized.slice(0, -1)
    // Keep "C:" from becoming a bare drive letter without root meaning —
    // normalize already yields "C:\" for the drive root on Windows.
    if (!isWin || !/^[a-z]:$/i.test(withoutTrailing)) {
      normalized = withoutTrailing
    }
  }

  return normalized
}

export function writeBlockReason(absolutePath: string): string | undefined {
  const stripped = normalizePathKey(absolutePath)
  // write-block list is authored with Windows-style lower-case prefixes.
  const blocked = WRITE_BLOCKED_PREFIXES.find((prefix) => {
    return stripped === prefix || stripped.startsWith(`${prefix}\\`) || stripped.startsWith(`${prefix}/`)
  })
  if (blocked) {
    return `writes under "${blocked}" are blocked for safety`
  }

  return undefined
}

/**
 * Whether `targetPath` equals or is nested under any of the registered free-
 * access roots (folder or file paths).
 *
 * Use when:
 * - Deciding if a write/edit may skip the approval dialog.
 * - Validating that a path the user is registering is not already covered.
 *
 * Expects:
 * - Absolute paths (already validated by {@link validateRequestPath}).
 * - Roots that are themselves absolute free-access registrations.
 *
 * Returns:
 * - true when the target is the root itself or a descendant (separator-bounded).
 */
export function isPathWithinRoots(targetPath: string, roots: readonly string[]): boolean {
  if (roots.length === 0) {
    return false
  }

  const target = normalizePathKey(targetPath)
  for (const root of roots) {
    const rootKey = normalizePathKey(root)
    if (!rootKey) {
      continue
    }
    if (target === rootKey) {
      return true
    }
    // Separator-bounded prefix so "C:\proj" does not match "C:\project".
    const boundary = rootKey.endsWith(sep) ? rootKey : `${rootKey}${sep}`
    // On Windows, free roots are stored with `\` after normalizePathKey; also
    // accept `/` boundaries from mixed input.
    const altBoundary = boundary.replaceAll('\\', '/')
    if (target.startsWith(boundary) || target.startsWith(altBoundary)) {
      return true
    }
  }

  return false
}

/**
 * Validates a path the user wants to register as free-access.
 *
 * Use when:
 * - Settings UI / IPC adds a free-access folder before persisting it.
 *
 * Expects:
 * - Any user-supplied string (absolute directory preferred).
 *
 * Returns:
 * - An error message, or undefined when the path may be registered.
 */
export function validateFreeAccessPath(rawPath: string): string | undefined {
  const invalid = validateRequestPath(rawPath)
  if (invalid) {
    return invalid
  }

  const blocked = writeBlockReason(rawPath)
  if (blocked) {
    return blocked
  }

  // Refuse registering a whole drive root (C:\) as free-write — too broad.
  const trimmed = rawPath.trim()
  const key = normalizePathKey(trimmed)
  if (process.platform === 'win32') {
    // Covers "C:", "C:\", "C:/", and normalize edge cases like "C." / "c".
    if (
      /^[a-z]:[/\\]?$/i.test(trimmed)
      || /^[a-z]:\\?$/i.test(key)
      || /^[a-z]$/i.test(key)
    ) {
      return 'registering a whole drive root as free-access is not allowed'
    }
  }
  if (key === '/' || key === '\\') {
    return 'registering the filesystem root as free-access is not allowed'
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
