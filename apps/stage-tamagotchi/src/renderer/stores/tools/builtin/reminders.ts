import type { Tool } from '@xsai/shared-chat'

import { tool } from '@xsai/tool'
import { z } from 'zod'

import { useRemindersStore, validateReminderMinutes } from '../../reminders'

/**
 * Formats a fire time as a short local time string for tool responses.
 *
 * Before:
 * - 1781250000000
 *
 * After:
 * - "오후 2:30" (locale-dependent)
 */
function formatDueTime(dueAt: number): string {
  return new Date(dueAt).toLocaleTimeString()
}

const tools: Promise<Tool>[] = [
  tool({
    name: 'set_reminder',
    description: 'Schedule a reminder. After the given minutes you will proactively tell the user the message in chat and an OS notification appears. Use for "remind me in N minutes" requests.',
    execute: async ({ minutes, message }) => {
      const invalid = validateReminderMinutes(minutes)
      if (invalid) {
        return `Error: ${invalid}`
      }

      const store = useRemindersStore()
      const dueAt = Date.now() + Math.round(minutes * 60 * 1000)
      const reminder = store.schedule(message, dueAt)
      return `OK: reminder set for ${formatDueTime(reminder.dueAt)} (id ${reminder.id})`
    },
    parameters: z.object({
      minutes: z.number().describe('Minutes from now until the reminder fires (e.g. 30)'),
      message: z.string().describe('What to remind the user about'),
    }),
  }),
  tool({
    name: 'list_reminders',
    description: 'List the user\'s pending reminders with their ids and fire times.',
    execute: async () => {
      const store = useRemindersStore()
      const items = store.list().map(item => ({ id: item.id, message: item.message, dueAt: formatDueTime(item.dueAt) }))
      return JSON.stringify(items)
    },
    parameters: z.object({}),
  }),
  tool({
    name: 'cancel_reminder',
    description: 'Cancel a pending reminder by its id (get ids from list_reminders).',
    execute: async ({ id }) => {
      const store = useRemindersStore()
      return store.cancel(id) ? `OK: cancelled ${id}` : `No reminder with id ${id}`
    },
    parameters: z.object({
      id: z.string().describe('The id of the reminder to cancel'),
    }),
  }),
]

export const reminderTools = async () => Promise.all(tools)
