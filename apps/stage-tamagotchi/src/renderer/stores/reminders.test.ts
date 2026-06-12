import { describe, expect, it } from 'vitest'

import { MAX_REMINDER_DELAY_MS, reminderDelayMs, validateReminderMinutes } from './reminders'

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
