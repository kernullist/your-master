/**
 * Pure policy helpers for the shell command execution tool. Kept free of
 * `electron`/`child_process` imports so they stay unit-testable in plain Node.
 */

import { isAbsolute } from 'node:path'

/** Hard ceiling on command runtime; runaway processes are killed. */
export const COMMAND_TIMEOUT_MS = 30_000

/** Max bytes of stdout/stderr returned to the model. */
export const COMMAND_OUTPUT_MAX_BYTES = 32 * 1024

// NOTICE:
// Categorically blocked commands. These are destructive, system-altering, or
// security-sensitive enough that even a user-approved dialog is the wrong UX
// (a mis-click could wipe a disk or disable security). The model should never
// be the thing that triggers them. Matched case-insensitively as whole words
// against the command string.
// Source: Windows-focused since this app targets Windows 10/11.
const BLOCKED_PATTERNS: { pattern: RegExp, reason: string }[] = [
  { pattern: /\bformat\b/i, reason: 'disk format' },
  { pattern: /\bdiskpart\b/i, reason: 'disk partitioning' },
  { pattern: /\bmkfs\b/i, reason: 'filesystem creation' },
  { pattern: /\b(rmdir|rd)\s+\/s\b/i, reason: 'recursive directory deletion' },
  { pattern: /\bdel\b.*\/s\b/i, reason: 'recursive file deletion' },
  // Remove-Item (and its PowerShell aliases ri/rd/rmdir/del/erase) with both
  // -Recurse and -Force in either order, allowing abbreviated flags (-re/-fo).
  { pattern: /\b(remove-item|ri|rd|rmdir|del|erase)\b[^|&;]*-r\w*\b[^|&;]*-f\w*\b/i, reason: 'recursive force deletion' },
  { pattern: /\b(remove-item|ri|rd|rmdir|del|erase)\b[^|&;]*-f\w*\b[^|&;]*-r\w*\b/i, reason: 'recursive force deletion' },
  // rm with a recursive flag in any order (-r, -rf, -fr, -R, --recursive).
  { pattern: /\brm\s+-{1,2}[a-z]*r/i, reason: 'recursive deletion' },
  { pattern: /\breg(\.exe)?\s+(delete|add)\b/i, reason: 'registry modification' },
  { pattern: /\bReg-/i, reason: 'registry cmdlet' },
  // Base64/encoded PowerShell hides the real payload from every other pattern.
  { pattern: /\bpowershell(\.exe)?\b[^|&;]*\s-e(c|nc|ncodedcommand)?\b/i, reason: 'encoded PowerShell command' },
  { pattern: /\bShutdown\b/i, reason: 'system shutdown' },
  { pattern: /\b(Restart|Stop)-Computer\b/i, reason: 'system power control' },
  { pattern: /\bbcdedit\b/i, reason: 'boot configuration' },
  { pattern: /\bcipher\s+\/w\b/i, reason: 'secure wipe' },
  { pattern: /\bvssadmin\b.+\bdelete\b/i, reason: 'shadow copy deletion (ransomware pattern)' },
  { pattern: /\bnetsh\b.+\bfirewall\b/i, reason: 'firewall modification' },
  { pattern: /\bSet-MpPreference\b/i, reason: 'antivirus modification' },
  { pattern: />\s*\/dev\/sd|\bdd\s+if=/i, reason: 'raw disk write' },
  { pattern: /:\(\)\s*\{.*\}\s*;/, reason: 'fork bomb' },
]

/**
 * Validates and screens a shell command before any approval dialog.
 *
 * Use when:
 * - Gatekeeping a model-supplied command string.
 *
 * Expects:
 * - Any string from the model.
 *
 * Returns:
 * - A block reason when the command is empty or categorically dangerous, or
 *   undefined when it may proceed to the user approval step.
 */
export function commandBlockReason(command: string): string | undefined {
  const trimmed = command?.trim()
  if (!trimmed) {
    return 'command is required'
  }

  const blocked = BLOCKED_PATTERNS.find(entry => entry.pattern.test(trimmed))
  if (blocked) {
    return `blocked: ${blocked.reason}. This command is never allowed; do not retry.`
  }

  return undefined
}

/**
 * Validates an optional working directory for the command.
 *
 * Returns an error message when a cwd is given but is not an absolute path,
 * or undefined when absent or valid.
 */
export function validateCwd(cwd?: string): string | undefined {
  if (cwd == null || cwd.trim() === '') {
    return undefined
  }

  if (!isAbsolute(cwd.trim())) {
    return `cwd must be an absolute path (got "${cwd}")`
  }

  return undefined
}

/**
 * Clamps captured process output to {@link COMMAND_OUTPUT_MAX_BYTES}.
 *
 * Before:
 * - 5 MB of build log
 *
 * After:
 * - First 32 KB plus a truncation marker
 */
export function clampOutput(text: string): string {
  if (text.length <= COMMAND_OUTPUT_MAX_BYTES) {
    return text
  }

  return `${text.slice(0, COMMAND_OUTPUT_MAX_BYTES)}\n... (output truncated)`
}
