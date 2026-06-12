import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'

/** A saved multi-step routine the user can re-run by name. */
export interface Routine {
  /** Normalized lookup key (lower-cased name). */
  key: string
  /** Display name as the user phrased it. */
  name: string
  /** Natural-language steps the model carries out with its other tools. */
  instruction: string
  createdAt: number
}

/** Cap on stored routines; keeps the list and any prompt echo bounded. */
export const MAX_ROUTINES = 100

/**
 * Normalizes a routine name into its lookup key.
 *
 * Before:
 * - "  Morning Routine "
 *
 * After:
 * - "morning routine"
 */
export function routineKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Validates a routine name.
 *
 * Returns an error message, or undefined when acceptable.
 */
export function validateRoutineName(name: string): string | undefined {
  if (!name || !name.trim()) {
    return 'name is required'
  }
  if (name.trim().length > 80) {
    return 'name is too long (max 80 chars)'
  }
  return undefined
}

/**
 * Saved-routine (macro) store: name a multi-step task once, re-run it later.
 *
 * A routine stores natural-language steps, not a fixed tool sequence — running
 * one returns its instruction so the model executes the steps with whatever
 * tools fit at the time (robust to changing tools/state). Persisted to
 * localStorage; global (not per character).
 */
export const useRoutinesStore = defineStore('routines', () => {
  const routines = useLocalStorage<Routine[]>('assistant/routines', [])

  function list(): Routine[] {
    return [...routines.value].sort((a, b) => a.name.localeCompare(b.name))
  }

  function get(name: string): Routine | undefined {
    const key = routineKey(name)
    return routines.value.find(item => item.key === key)
  }

  /**
   * Creates or updates a routine (upsert on normalized name). Returns the
   * saved routine, or null when the cap is reached for a new name.
   */
  function save(name: string, instruction: string, now: number): Routine | null {
    const key = routineKey(name)
    const existingIndex = routines.value.findIndex(item => item.key === key)

    if (existingIndex === -1 && routines.value.length >= MAX_ROUTINES) {
      return null
    }

    const routine: Routine = { key, name: name.trim(), instruction: instruction.trim(), createdAt: now }
    if (existingIndex === -1) {
      routines.value = [...routines.value, routine]
    }
    else {
      // Preserve the original createdAt on update.
      routine.createdAt = routines.value[existingIndex].createdAt
      const next = [...routines.value]
      next[existingIndex] = routine
      routines.value = next
    }
    return routine
  }

  /** Removes a routine by name; returns true when something was removed. */
  function remove(name: string): boolean {
    const key = routineKey(name)
    const before = routines.value.length
    routines.value = routines.value.filter(item => item.key !== key)
    return routines.value.length < before
  }

  return {
    routines,
    list,
    get,
    save,
    remove,
  }
})
