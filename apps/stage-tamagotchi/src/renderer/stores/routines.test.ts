// @vitest-environment jsdom
// jsdom provides window.localStorage, which the store uses via vueuse's
// useLocalStorage; avoids stubbing the global directly.
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { MAX_ROUTINES, routineKey, useRoutinesStore, validateRoutineName } from './routines'

describe('routineKey', () => {
  it('lower-cases and collapses whitespace', () => {
    expect(routineKey('  Morning   Routine ')).toBe('morning routine')
  })
})

describe('validateRoutineName', () => {
  it('rejects empty names', () => {
    expect(validateRoutineName('')).toContain('required')
    expect(validateRoutineName('   ')).toContain('required')
  })

  it('rejects overly long names', () => {
    expect(validateRoutineName('x'.repeat(81))).toContain('too long')
  })

  it('accepts ordinary names', () => {
    expect(validateRoutineName('morning routine')).toBeUndefined()
  })
})

describe('useRoutinesStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('saves and retrieves a routine by case-insensitive name', () => {
    const store = useRoutinesStore()
    store.save('Morning Routine', 'check weather then read todos', 1000)
    const found = store.get('morning routine')
    expect(found?.name).toBe('Morning Routine')
    expect(found?.instruction).toBe('check weather then read todos')
  })

  it('upserts on the same normalized name and preserves createdAt', () => {
    const store = useRoutinesStore()
    store.save('Routine', 'first', 1000)
    store.save('  routine ', 'second', 2000)
    expect(store.list()).toHaveLength(1)
    const found = store.get('routine')
    expect(found?.instruction).toBe('second')
    expect(found?.createdAt).toBe(1000)
  })

  it('deletes a routine by name', () => {
    const store = useRoutinesStore()
    store.save('temp', 'x', 1000)
    expect(store.remove('TEMP')).toBe(true)
    expect(store.list()).toHaveLength(0)
    expect(store.remove('temp')).toBe(false)
  })

  it('refuses new routines past the cap but still allows updates', () => {
    const store = useRoutinesStore()
    for (let i = 0; i < MAX_ROUTINES; i += 1) {
      store.save(`routine-${i}`, 'x', 1000 + i)
    }
    expect(store.save('one-too-many', 'x', 9999)).toBeNull()
    // Updating an existing routine still works at the cap.
    expect(store.save('routine-0', 'updated', 9999)).not.toBeNull()
    expect(store.get('routine-0')?.instruction).toBe('updated')
  })
})
