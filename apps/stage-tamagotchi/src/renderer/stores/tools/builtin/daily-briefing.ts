import type { Tool } from '@xsai/shared-chat'

import { tool } from '@xsai/tool'
import { z } from 'zod'

import { BRIEFING_WINDOW_MS, selectUpcomingReminders, useRemindersStore } from '../../reminders'
import { useTodosStore } from '../../todos'

const tools: Promise<Tool>[] = [
  tool({
    name: 'daily_briefing',
    description: 'Gather the user\'s day-at-a-glance: current date/time, pending to-dos, and upcoming reminders/timers (next 24h). Use for "what\'s my day look like?" or a morning briefing. After calling this, optionally add weather (get_weather) and headlines (web search), then summarize it warmly in chat.',
    execute: async () => {
      const now = Date.now()
      const todosStore = useTodosStore()
      const remindersStore = useRemindersStore()

      const upcoming = selectUpcomingReminders(remindersStore.reminders, now, BRIEFING_WINDOW_MS)
        .map(reminder => ({ message: reminder.message, dueAt: new Date(reminder.dueAt).toLocaleString() }))

      const todos = todosStore.pending().map(todo => todo.text)

      return JSON.stringify({
        now: new Date(now).toLocaleString(),
        weekday: new Date(now).toLocaleDateString(undefined, { weekday: 'long' }),
        pendingTodos: todos,
        upcoming,
        hint: 'Add weather via get_weather and headlines via web search if helpful, then give a short warm briefing.',
      })
    },
    parameters: z.object({}),
  }),
]

export const dailyBriefingTools = async () => Promise.all(tools)
