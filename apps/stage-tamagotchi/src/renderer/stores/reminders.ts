import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'

import { electronNotify } from '../../shared/eventa'

/** A scheduled reminder. */
export interface Reminder {
  id: string
  /** What to remind the user about. */
  message: string
  /** Absolute fire time, epoch ms. */
  dueAt: number
  createdAt: number
}

/** Upper bound on how far ahead a reminder may be scheduled (~30 days). */
export const MAX_REMINDER_DELAY_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Computes the setTimeout delay for a reminder, clamped to non-negative.
 *
 * Use when:
 * - Arming a timer for a reminder, including rescheduling at startup where the
 *   reminder may already be past due (delay 0 -> fire ASAP).
 *
 * Returns:
 * - Milliseconds from `now` until `dueAt`, never negative.
 */
export function reminderDelayMs(dueAt: number, now: number): number {
  return Math.max(0, dueAt - now)
}

/**
 * Validates a requested reminder delay in minutes.
 *
 * Returns an error message, or undefined when acceptable.
 */
export function validateReminderMinutes(minutes: number): string | undefined {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return 'minutes must be a positive number'
  }

  if (minutes * 60 * 1000 > MAX_REMINDER_DELAY_MS) {
    return 'reminder is too far in the future (max ~30 days)'
  }

  return undefined
}

/**
 * Converts a timer duration to milliseconds.
 *
 * Before:
 * - (10, 'minutes') / (30, 'seconds')
 *
 * After:
 * - 600000 / 30000
 */
export function timerDurationMs(value: number, unit: 'seconds' | 'minutes'): number {
  return unit === 'minutes' ? value * 60 * 1000 : value * 1000
}

/**
 * Validates a timer duration.
 *
 * Returns an error message, or undefined when acceptable. Shares the reminder
 * scheduler's upper bound since a timer is a countdown reminder.
 */
export function validateTimerDuration(value: number, unit: 'seconds' | 'minutes'): string | undefined {
  if (!Number.isFinite(value) || value <= 0) {
    return 'duration must be a positive number'
  }
  if (timerDurationMs(value, unit) > MAX_REMINDER_DELAY_MS) {
    return 'timer is too long (max ~30 days)'
  }
  return undefined
}

/**
 * Reminder scheduler. Reminders persist to localStorage and survive reloads;
 * on init, pending reminders are re-armed and past-due ones fire shortly after.
 *
 * On fire, AIRI proactively speaks the reminder in the active chat session and
 * shows an OS notification (so it is seen even when the window is hidden).
 */
export const useRemindersStore = defineStore('reminders', () => {
  const reminders = useLocalStorage<Reminder[]>('assistant/reminders', [])
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let invokeNotify: ((payload: { title: string, body: string }) => Promise<{ ok: boolean }>) | undefined

  function getNotifier() {
    if (!invokeNotify) {
      const { context } = createContext(window.electron.ipcRenderer)
      invokeNotify = defineInvoke(context, electronNotify)
    }
    return invokeNotify
  }

  function fire(reminder: Reminder) {
    timers.delete(reminder.id)
    reminders.value = reminders.value.filter(item => item.id !== reminder.id)

    const text = `⏰ 리마인더: ${reminder.message}`
    try {
      const chatSession = useChatSessionStore()
      const sessionId = chatSession.activeSessionId
      if (sessionId) {
        chatSession.appendSessionMessage(sessionId, {
          role: 'assistant',
          content: text,
          slices: [{ type: 'text', text }],
          tool_results: [],
          createdAt: Date.now(),
        })
      }
    }
    catch (error) {
      console.error('[reminders] failed to append reminder message', error)
    }

    void getNotifier()({ title: 'AIRI 리마인더', body: reminder.message }).catch(() => {})
  }

  function arm(reminder: Reminder) {
    if (timers.has(reminder.id)) {
      return
    }
    const delay = reminderDelayMs(reminder.dueAt, Date.now())
    timers.set(reminder.id, setTimeout(fire, delay, reminder))
  }

  /** Re-arms all persisted reminders; call once at app startup. */
  function initialize() {
    for (const reminder of reminders.value) {
      arm(reminder)
    }
  }

  function schedule(message: string, dueAt: number): Reminder {
    const reminder: Reminder = {
      id: `rem-${Date.now()}-${reminders.value.length}`,
      message: message.trim(),
      dueAt,
      createdAt: Date.now(),
    }
    reminders.value = [...reminders.value, reminder]
    arm(reminder)
    return reminder
  }

  function list(): Reminder[] {
    return [...reminders.value].sort((a, b) => a.dueAt - b.dueAt)
  }

  function cancel(id: string): boolean {
    const timer = timers.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(id)
    }
    const before = reminders.value.length
    reminders.value = reminders.value.filter(item => item.id !== id)
    return reminders.value.length < before
  }

  return {
    reminders,
    initialize,
    schedule,
    list,
    cancel,
  }
})
