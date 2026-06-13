import type { Tool } from '@xsai/shared-chat'

import { tool } from '@xsai/tool'
import { z } from 'zod'

import { resolveTodo, useTodosStore, validateTodoText } from '../../todos'

const tools: Promise<Tool>[] = [
  tool({
    name: 'add_todo',
    description: 'Add an item to the user\'s personal to-do list. Use when the user says they need or want to do something later.',
    execute: async ({ text }) => {
      const invalid = validateTodoText(text)
      if (invalid) {
        return `Error: ${invalid}`
      }
      const store = useTodosStore()
      const added = store.add(text, Date.now())
      if (!added) {
        return 'Error: the to-do list is full; complete or remove some items first'
      }
      return `OK: added to-do "${added.text}"`
    },
    parameters: z.object({
      text: z.string().describe('The to-do item, e.g. "email the contract to Jane"'),
    }),
  }),
  tool({
    name: 'list_todos',
    // strict:false because `includeDone` is optional (see file-access note).
    strict: false,
    description: 'List the user\'s to-do items. By default only pending items; pass includeDone to also show completed ones.',
    execute: async ({ includeDone }) => {
      const store = useTodosStore()
      const items = store.list(includeDone ?? false).map(todo => ({ id: todo.id, text: todo.text, done: todo.done }))
      return JSON.stringify({ todos: items, pendingCount: store.pending().length })
    },
    parameters: z.object({
      includeDone: z.boolean().optional().describe('Include completed items too (default false)'),
    }),
  }),
  tool({
    name: 'complete_todo',
    description: 'Mark a to-do item as done. Identify it by its id or by a unique part of its text.',
    execute: async ({ match }) => {
      const store = useTodosStore()
      const resolved = resolveTodo(store.pending(), match)
      if (!resolved.ok || !resolved.todo) {
        return `Error: ${resolved.error}`
      }
      store.complete(resolved.todo.id, Date.now())
      return `OK: completed "${resolved.todo.text}"`
    },
    parameters: z.object({
      match: z.string().describe('The todo id, or a unique part of its text'),
    }),
  }),
  tool({
    name: 'remove_todo',
    description: 'Remove a to-do item entirely (pending or done). Identify it by its id or a unique part of its text.',
    execute: async ({ match }) => {
      const store = useTodosStore()
      const resolved = resolveTodo(store.list(true), match)
      if (!resolved.ok || !resolved.todo) {
        return `Error: ${resolved.error}`
      }
      store.remove(resolved.todo.id)
      return `OK: removed "${resolved.todo.text}"`
    },
    parameters: z.object({
      match: z.string().describe('The todo id, or a unique part of its text'),
    }),
  }),
]

export const todoTools = async () => Promise.all(tools)
