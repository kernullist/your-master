import type { Tool } from '@xsai/shared-chat'

import { tool } from '@xsai/tool'
import { z } from 'zod'

import { useRoutinesStore, validateRoutineName } from '../../routines'

const tools: Promise<Tool>[] = [
  tool({
    name: 'save_routine',
    description: 'Save a named multi-step routine (macro) the user can re-run later, e.g. "morning routine". Store the steps as clear natural-language instructions. Use when the user asks you to remember a sequence of actions to repeat.',
    execute: async ({ name, instruction }) => {
      const invalid = validateRoutineName(name)
      if (invalid) {
        return `Error: ${invalid}`
      }
      const store = useRoutinesStore()
      const saved = store.save(name, instruction, Date.now())
      if (!saved) {
        return 'Error: too many routines saved; delete one first'
      }
      return `OK: saved routine "${saved.name}"`
    },
    parameters: z.object({
      name: z.string().describe('Short routine name, e.g. "morning routine"'),
      instruction: z.string().describe('The steps to perform, as clear natural-language instructions'),
    }),
  }),
  tool({
    name: 'run_routine',
    description: 'Look up a saved routine by name and return its steps. After calling this, carry out the returned steps yourself using your other tools (search, files, commands, etc.). Use when the user asks to run or do a named routine.',
    execute: async ({ name }) => {
      const store = useRoutinesStore()
      const routine = store.get(name)
      if (!routine) {
        const names = store.list().map(item => item.name)
        return `No routine named "${name}".${names.length ? ` Saved routines: ${names.join(', ')}` : ' No routines saved yet.'}`
      }
      return JSON.stringify({ name: routine.name, steps: routine.instruction })
    },
    parameters: z.object({
      name: z.string().describe('The routine name to run'),
    }),
  }),
  tool({
    name: 'list_routines',
    description: 'List the user\'s saved routines with their names and steps.',
    execute: async () => {
      const store = useRoutinesStore()
      return JSON.stringify(store.list().map(item => ({ name: item.name, steps: item.instruction })))
    },
    parameters: z.object({}),
  }),
  tool({
    name: 'delete_routine',
    description: 'Delete a saved routine by name.',
    execute: async ({ name }) => {
      const store = useRoutinesStore()
      return store.remove(name) ? `OK: deleted routine "${name}"` : `No routine named "${name}"`
    },
    parameters: z.object({
      name: z.string().describe('The routine name to delete'),
    }),
  }),
]

export const routineTools = async () => Promise.all(tools)
