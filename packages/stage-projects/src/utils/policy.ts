import type { ProjectAgentSettings } from '../types/agent-config.ts'

/**
 * Checks whether a shell command is allowed by AIRI's project policy.
 *
 * Use when:
 * - The worker agent asks to run a command
 *
 * Expects:
 * - Commands are raw user-shell strings
 *
 * Returns:
 * - Allow/deny result with a human-readable reason
 */
export function evaluateShellCommandPolicy(command: string, settings: Pick<ProjectAgentSettings, 'shellAllowlist' | 'shellDenylist'>): { allowed: boolean, reason?: string } {
  const normalizedCommand = command.trim().toLowerCase()
  const denied = settings.shellDenylist.find(item => normalizedCommand.includes(item.toLowerCase()))
  if (denied) {
    return { allowed: false, reason: `Command includes denied token: ${denied}` }
  }

  if (settings.shellAllowlist.length === 0) {
    return { allowed: true }
  }

  const allowed = settings.shellAllowlist.some(item => normalizedCommand.startsWith(item.toLowerCase()))
  return allowed ? { allowed: true } : { allowed: false, reason: 'Command does not match the shell allowlist.' }
}

/**
 * Checks whether a relative path is editable by the worker.
 *
 * Use when:
 * - File tools need to enforce forbidden project paths
 *
 * Expects:
 * - `relativePath` is already normalized relative to the project root
 *
 * Returns:
 * - True when no forbidden fragment matches
 */
export function isPathAllowed(relativePath: string, forbiddenPathPatterns: string[]): boolean {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase()
  return !forbiddenPathPatterns.some(pattern => normalized.includes(pattern.replace(/\\/g, '/').toLowerCase()))
}
