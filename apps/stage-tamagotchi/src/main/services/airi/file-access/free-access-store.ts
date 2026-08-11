import * as v from 'valibot'

import { createConfig } from '../../../libs/electron/persistence'
import { normalizePathKey, validateFreeAccessPath } from './policy'

/** Persisted free-access path list (model may write without approval under these). */
export const freeAccessConfigSchema = v.object({
  version: v.literal(1),
  /** Absolute directory/file paths registered by the user. */
  paths: v.array(v.string()),
})

export type FreeAccessConfig = v.InferOutput<typeof freeAccessConfigSchema>

/**
 * Default empty free-access configuration.
 *
 * Use when:
 * - Initializing persistence for a first-run install.
 */
export function createDefaultFreeAccessConfig(): FreeAccessConfig {
  return {
    version: 1,
    paths: [],
  }
}

/**
 * Normalizes and deduplicates free-access paths for persistence.
 *
 * Before:
 * - ["C:\\Users\\me\\Notes\\", "c:\\users\\me\\notes", "  ", "D:\\work"]
 *
 * After:
 * - ["C:\\Users\\me\\Notes", "D:\\work"]  (first-seen casing kept; invalid dropped)
 *
 * Use when:
 * - Saving a mutated free-access list so equality checks stay stable.
 */
export function normalizeFreeAccessPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const raw of paths) {
    const trimmed = raw?.trim()
    if (!trimmed) {
      continue
    }
    if (validateFreeAccessPath(trimmed)) {
      continue
    }
    const key = normalizePathKey(trimmed)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    // Prefer a trailing-separator-free absolute form without rewriting drive case.
    const cleaned = trimmed.replace(/[/\\]+$/, '') || trimmed
    result.push(cleaned)
  }

  return result
}

/**
 * Creates the free-access path config store bound to Electron userData.
 *
 * Use when:
 * - The file-access service boots and needs durable free-write roots.
 *
 * Expects:
 * - Electron `app.whenReady()` has resolved (createConfig uses userData).
 *
 * Returns:
 * - `{ setup, getPaths, setPaths, addPath, removePath }` facade.
 *
 * Call stack:
 *
 * createFileAccessService (./index)
 *   -> {@link createFreeAccessStore}
 *     -> createConfig('file-access', 'free-access.json')
 */
export function createFreeAccessStore() {
  const config = createConfig(
    'file-access',
    'free-access.json',
    freeAccessConfigSchema,
    {
      default: createDefaultFreeAccessConfig(),
      autoHeal: true,
    },
  )

  config.setup()

  function getPaths(): string[] {
    return [...(config.get()?.paths ?? [])]
  }

  function setPaths(paths: readonly string[]): string[] {
    const next = normalizeFreeAccessPaths(paths)
    config.update({ version: 1, paths: next })
    return next
  }

  /**
   * Adds a free-access path if valid and not already covered by an existing root.
   *
   * Returns:
   * - `{ ok, paths, message?, path? }` with the updated list.
   */
  function addPath(rawPath: string): { ok: boolean, paths: string[], message?: string, path?: string } {
    const trimmed = rawPath?.trim() ?? ''
    const invalid = validateFreeAccessPath(trimmed)
    if (invalid) {
      return { ok: false, paths: getPaths(), message: invalid }
    }

    const current = getPaths()
    const key = normalizePathKey(trimmed)
    if (current.some(existing => normalizePathKey(existing) === key)) {
      return { ok: true, paths: current, message: 'path already registered', path: trimmed }
    }

    // If a parent is already free-access, registering a child is redundant.
    if (current.some((existing) => {
      const existingKey = normalizePathKey(existing)
      return key === existingKey || key.startsWith(`${existingKey}\\`) || key.startsWith(`${existingKey}/`)
    })) {
      return { ok: true, paths: current, message: 'path is already covered by an existing free-access root', path: trimmed }
    }

    // Drop children that become redundant when registering a parent.
    const withoutCoveredChildren = current.filter((existing) => {
      const existingKey = normalizePathKey(existing)
      return !existingKey.startsWith(`${key}\\`) && !existingKey.startsWith(`${key}/`)
    })

    const cleaned = trimmed.replace(/[/\\]+$/, '') || trimmed
    const next = setPaths([...withoutCoveredChildren, cleaned])
    return { ok: true, paths: next, path: cleaned }
  }

  function removePath(rawPath: string): { ok: boolean, paths: string[], message?: string } {
    const trimmed = rawPath?.trim() ?? ''
    if (!trimmed) {
      return { ok: false, paths: getPaths(), message: 'path is required' }
    }

    const key = normalizePathKey(trimmed)
    const current = getPaths()
    const next = current.filter(existing => normalizePathKey(existing) !== key)
    if (next.length === current.length) {
      return { ok: false, paths: current, message: 'path is not registered' }
    }

    return { ok: true, paths: setPaths(next) }
  }

  return {
    getPaths,
    setPaths,
    addPath,
    removePath,
  }
}

export type FreeAccessStore = ReturnType<typeof createFreeAccessStore>
