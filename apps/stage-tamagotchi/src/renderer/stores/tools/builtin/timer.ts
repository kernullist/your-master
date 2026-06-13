import type { Tool } from '@xsai/shared-chat'

import { tool } from '@xsai/tool'
import { z } from 'zod'

import { timerDurationMs, useRemindersStore, validateTimerDuration } from '../../reminders'

/**
 * Timer tools. A countdown timer is a short-fuse reminder, so these reuse the
 * reminders store/scheduler (persistence, re-arming, proactive chat message +
 * OS notification on fire). The only differences from set_reminder are
 * second-level precision and countdown framing; timers appear in
 * list_reminders / cancel_reminder alongside reminders.
 */
const tools: Promise<Tool>[] = [
  tool({
    name: 'set_timer',
    // strict:false because `unit` and `label` are optional (see file-access note).
    strict: false,
    description: 'Start a countdown timer. When it elapses you proactively tell the user in chat and an OS notification appears. Supports seconds or minutes. To cancel or view a timer, use cancel_reminder / list_reminders (timers appear there).',
    execute: async ({ duration, unit, label }) => {
      const resolvedUnit = unit === 'seconds' ? 'seconds' : 'minutes'
      const invalid = validateTimerDuration(duration, resolvedUnit)
      if (invalid) {
        return `Error: ${invalid}`
      }
      const store = useRemindersStore()
      const dueAt = Date.now() + timerDurationMs(duration, resolvedUnit)
      const message = label?.trim() || `${duration} ${resolvedUnit} timer`
      const reminder = store.schedule(`타이머: ${message}`, dueAt)
      return `OK: timer set for ${duration} ${resolvedUnit} (id ${reminder.id})`
    },
    parameters: z.object({
      duration: z.number().describe('How long until the timer fires'),
      unit: z.enum(['seconds', 'minutes']).optional().describe('Time unit (default minutes)'),
      label: z.string().optional().describe('Optional label for what the timer is for'),
    }),
  }),
]

export const timerTools = async () => Promise.all(tools)
