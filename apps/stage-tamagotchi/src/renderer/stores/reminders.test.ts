import { describe, expect, it } from 'vitest'

import { MAX_REMINDER_DELAY_MS, reminderDelayMs, timerDurationMs, validateReminderMinutes, validateTimerDuration } from './reminders'

describe('reminderDelayMs', () => {
  it('returns the gap until the due time', () => {
    expect(reminderDelayMs(5000, 2000)).toBe(3000)
  })

  it('clamps past-due reminders to zero (fire ASAP on reschedule)', () => {
    expect(reminderDelayMs(1000, 5000)).toBe(0)
  })
})

describe('validateReminderMinutes', () => {
  it('rejects non-positive or non-finite values', () => {
    expect(validateReminderMinutes(0)).toContain('positive')
    expect(validateReminderMinutes(-5)).toContain('positive')
    expect(validateReminderMinutes(Number.NaN)).toContain('positive')
  })

  it('rejects delays beyond the maximum', () => {
    const tooManyMinutes = MAX_REMINDER_DELAY_MS / (60 * 1000) + 1
    expect(validateReminderMinutes(tooManyMinutes)).toContain('too far')
  })

  it('accepts ordinary delays', () => {
    expect(validateReminderMinutes(30)).toBeUndefined()
    expect(validateReminderMinutes(0.5)).toBeUndefined()
    expect(validateReminderMinutes(60 * 24)).toBeUndefined()
  })
})

describe('timerDurationMs', () => {
  it('converts seconds and minutes', () => {
    expect(timerDurationMs(30, 'seconds')).toBe(30_000)
    expect(timerDurationMs(10, 'minutes')).toBe(600_000)
  })
})

describe('validateTimerDuration', () => {
  it('rejects non-positive durations', () => {
    expect(validateTimerDuration(0, 'seconds')).toContain('positive')
    expect(validateTimerDuration(-1, 'minutes')).toContain('positive')
  })

  it('rejects durations beyond the scheduler bound', () => {
    expect(validateTimerDuration(MAX_REMINDER_DELAY_MS / 1000 + 1, 'seconds')).toContain('too long')
  })

  it('accepts short and ordinary timers', () => {
    expect(validateTimerDuration(30, 'seconds')).toBeUndefined()
    expect(validateTimerDuration(25, 'minutes')).toBeUndefined()
  })
})
