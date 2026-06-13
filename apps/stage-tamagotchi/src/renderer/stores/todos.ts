import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'

/** A personal to-do item. */
export interface Todo {
  id: string
  text: string
  done: boolean
  createdAt: number
  completedAt?: number
}

/** Cap on stored todos; keeps the list and any prompt echo bounded. */
export const MAX_TODOS = 200

/**
 * Monotonic id counter. `Date.now()-listLength` reused ids after removals
 * (length is reused), which made id-based complete/remove hit the wrong item;
 * a counter guarantees per-session uniqueness.
 */
let todoIdCounter = 0

/** Validates to-do text. Returns an error message, or undefined. */
export function validateTodoText(text: string): string | undefined {
  const trimmed = text?.trim()
  if (!trimmed) {
    return 'todo text is required'
  }
  if (trimmed.length > 300) {
    return 'todo text is too long (max 300 chars)'
  }
  return undefined
}

/** Outcome of resolving a free-text reference to a single pending todo. */
export interface TodoMatchResult {
  ok: boolean
  todo?: Todo
  error?: string
}

/**
 * Resolves a user phrase to a single todo by id or unique text substring.
 *
 * Use when:
 * - Completing or removing a todo the user referred to in words
 *   ("mark buy milk done") rather than by id.
 *
 * Expects:
 * - `candidates` is the list to search (e.g. pending todos for completion).
 *
 * Returns:
 * - `{ ok: true, todo }` on an exact id or unique case-insensitive substring
 *   match; `{ ok: false, error }` when nothing matches or it is ambiguous.
 */
export function resolveTodo(candidates: Todo[], match: string): TodoMatchResult {
  const trimmed = match?.trim()
  if (!trimmed) {
    return { ok: false, error: 'a todo id or text to match is required' }
  }

  const byId = candidates.find(todo => todo.id === trimmed)
  if (byId) {
    return { ok: true, todo: byId }
  }

  const needle = trimmed.toLowerCase()
  const textMatches = candidates.filter(todo => todo.text.toLowerCase().includes(needle))
  if (textMatches.length === 1) {
    return { ok: true, todo: textMatches[0] }
  }
  if (textMatches.length === 0) {
    return { ok: false, error: `no matching todo for "${trimmed}"` }
  }
  return { ok: false, error: `"${trimmed}" matches ${textMatches.length} todos; be more specific` }
}

/**
 * Personal to-do list store. Items have a done/pending state (unlike memory
 * facts or routines) and persist to localStorage across restarts. Global, not
 * per character.
 */
export const useTodosStore = defineStore('todos', () => {
  const todos = useLocalStorage<Todo[]>('assistant/todos', [])

  function list(includeDone = false): Todo[] {
    const items = includeDone ? todos.value : todos.value.filter(todo => !todo.done)
    // Pending first, then by creation order.
    return [...items].sort((a, b) => Number(a.done) - Number(b.done) || a.createdAt - b.createdAt)
  }

  function pending(): Todo[] {
    return todos.value.filter(todo => !todo.done)
  }

  /** Adds a todo. Returns the created item, or null when the cap is reached. */
  function add(text: string, now: number): Todo | null {
    if (todos.value.length >= MAX_TODOS) {
      return null
    }
    todoIdCounter += 1
    const todo: Todo = { id: `todo-${now}-${todoIdCounter}`, text: text.trim(), done: false, createdAt: now }
    todos.value = [...todos.value, todo]
    return todo
  }

  /** Marks a resolved todo done (idempotent). */
  function complete(id: string, now: number): boolean {
    const index = todos.value.findIndex(todo => todo.id === id)
    if (index === -1) {
      return false
    }
    const next = [...todos.value]
    next[index] = { ...next[index], done: true, completedAt: now }
    todos.value = next
    return true
  }

  /** Removes a todo by id. */
  function remove(id: string): boolean {
    const before = todos.value.length
    todos.value = todos.value.filter(todo => todo.id !== id)
    return todos.value.length < before
  }

  /** Drops all completed todos; returns how many were cleared. */
  function clearCompleted(): number {
    const before = todos.value.length
    todos.value = todos.value.filter(todo => !todo.done)
    return before - todos.value.length
  }

  return {
    todos,
    list,
    pending,
    add,
    complete,
    remove,
    clearCompleted,
  }
})
