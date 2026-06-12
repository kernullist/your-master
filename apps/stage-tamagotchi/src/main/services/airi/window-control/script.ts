/**
 * Pure helpers for the window-control service: input validation and parsing
 * of PowerShell output. No `electron`/`child_process` imports so they stay
 * unit-testable in plain Node.
 *
 * NOTICE:
 * Windows GUI control here is intentionally limited to window management
 * (list / focus / graceful close). Mouse and keyboard injection are NOT
 * implemented: they require native modules (nut.js/robotjs) and carry a high
 * misfire risk. The macOS-only @proj-airi/computer-use-mcp does not apply on
 * Windows.
 */

import type { ElectronWindowEntry } from '../../../../shared/eventa'

/** Max windows returned; keeps the list and any prompt echo bounded. */
export const WINDOW_LIST_MAX = 60

/**
 * Validates a window match string supplied by the model.
 *
 * Returns an error message, or undefined when acceptable. A match must be
 * non-trivial so "focus any window" cannot act on an arbitrary target.
 */
export function validateWindowMatch(match: string): string | undefined {
  const trimmed = match?.trim()
  if (!trimmed) {
    return 'match is required (a substring of the window title)'
  }
  if (trimmed.length < 2) {
    return 'match must be at least 2 characters to avoid matching the wrong window'
  }
  return undefined
}

interface RawWindow {
  Id?: number
  ProcessName?: string
  MainWindowTitle?: string
}

/**
 * Parses `ConvertTo-Json` output of the window list into typed entries.
 *
 * Before:
 * - '{"Id":1,"ProcessName":"brave","MainWindowTitle":"X"}' (single object)
 * - '[{...},{...}]' (array)
 * - '' (no windows)
 *
 * After:
 * - ElectronWindowEntry[] (always an array), capped at {@link WINDOW_LIST_MAX}
 *
 * PowerShell emits a bare object (not a 1-element array) when exactly one
 * window matches, and nothing when none do — both are normalized here.
 */
export function parseWindowList(jsonText: string): ElectronWindowEntry[] {
  const trimmed = jsonText.trim()
  if (!trimmed) {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  }
  catch {
    return []
  }

  const rawList: RawWindow[] = Array.isArray(parsed) ? parsed as RawWindow[] : [parsed as RawWindow]

  return rawList
    .filter(raw => raw && typeof raw.Id === 'number' && typeof raw.MainWindowTitle === 'string')
    .slice(0, WINDOW_LIST_MAX)
    .map(raw => ({
      processId: raw.Id as number,
      process: raw.ProcessName ?? 'unknown',
      title: raw.MainWindowTitle as string,
    }))
}
