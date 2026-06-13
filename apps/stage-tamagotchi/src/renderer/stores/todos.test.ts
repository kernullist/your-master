// @vitest-environment jsdom
// jsdom provides window.localStorage, which the store uses via vueuse's
// useLocalStorage; avoids stubbing the global directly.
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { MAX_TODOS, resolveTodo, useTodosStore, validateTodoText } from './todos'

describe('validateTodoText', () => {
  it('rejects empty text', () => {
    expect(validateTodoText('')).toContain('required')
    expect(validateTodoText('   ')).toContain('required')
  })

  it('rejects overly long text', () => {
    expect(validateTodoText('x'.repeat(301))).toContain('too long')
  })

  it('accepts normal text', () => {
    expect(validateTodoText('email Jane')).toBeUndefined()
  })
})

describe('resolveTodo', () => {
  const todos = [
    { id: 'a', text: 'Buy milk', done: false, createdAt: 1 },
    { id: 'b', text: 'Buy bread', done: false, createdAt: 2 },
    { id: 'c', text: 'Call dentist', done: false, createdAt: 3 },
  ]

  it('resolves by exact id', () => {
    expect(resolveTodo(todos, 'c').todo?.text).toBe('Call dentist')
  })

  it('resolves by unique text substring, case-insensitive', () => {
    expect(resolveTodo(todos, 'dentist').todo?.id).toBe('c')
    expect(resolveTodo(todos, 'CALL').todo?.id).toBe('c')
  })

  it('rejects an ambiguous substring', () => {
    expect(resolveTodo(todos, 'buy').error).toContain('matches 2')
  })

  it('rejects no match and empty input', () => {
    expect(resolveTodo(todos, 'xyz').error).toContain('no matching')
    expect(resolveTodo(todos, '  ').error).toContain('required')
  })
})

describe('useTodosStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('adds and lists pending todos', () => {
    const store = useTodosStore()
    store.add('first', 1000)
    store.add('second', 1001)
    expect(store.list().map(t => t.text)).toEqual(['first', 'second'])
    expect(store.pending()).toHaveLength(2)
  })

  it('completes a todo and hides it from the default list', () => {
    const store = useTodosStore()
    const t = store.add('done me', 1000)!
    expect(store.complete(t.id, 2000)).toBe(true)
    expect(store.list()).toHaveLength(0)
    expect(store.list(true)).toHaveLength(1)
    expect(store.list(true)[0].completedAt).toBe(2000)
  })

  it('sorts pending before done in the full list', () => {
    const store = useTodosStore()
    const a = store.add('a', 1000)!
    store.add('b', 1001)
    store.complete(a.id, 2000)
    expect(store.list(true).map(t => t.text)).toEqual(['b', 'a'])
  })

  it('removes and clears completed', () => {
    const store = useTodosStore()
    const a = store.add('a', 1000)!
    const b = store.add('b', 1001)!
    store.complete(a.id, 2000)
    expect(store.clearCompleted()).toBe(1)
    expect(store.list(true).map(t => t.text)).toEqual(['b'])
    expect(store.remove(b.id)).toBe(true)
    expect(store.list(true)).toHaveLength(0)
  })

  it('refuses to add past the cap', () => {
    const store = useTodosStore()
    for (let i = 0; i < MAX_TODOS; i += 1) {
      store.add(`t${i}`, 1000 + i)
    }
    expect(store.add('one too many', 9999)).toBeNull()
  })
})
