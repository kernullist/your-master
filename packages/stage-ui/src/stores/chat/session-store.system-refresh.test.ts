import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useChatSessionStore } from './session-store'

// Ref-like holder usable inside hoisted vi.mock factories (a real vue ref
// cannot be created there because imports are not hoisted along).
const mocks = vi.hoisted(() => ({
  userId: { value: 'user-1' },
  activeCardId: { value: 'card-1' },
  systemPrompt: { value: 'PROMPT A' },
}))

vi.mock('pinia', async () => {
  const actual = await vi.importActual<typeof import('pinia')>('pinia')
  return {
    ...actual,
    storeToRefs: (store: any) => store,
  }
})

vi.mock('../auth', () => ({
  useAuthStore: () => ({ userId: mocks.userId }),
}))

vi.mock('../modules/airi-card', () => ({
  useAiriCardStore: () => ({
    activeCardId: mocks.activeCardId,
    systemPrompt: mocks.systemPrompt,
  }),
}))

vi.mock('../../database/repos/chat-sessions.repo', () => ({
  chatSessionsRepo: {
    getIndex: vi.fn().mockResolvedValue(null),
    saveIndex: vi.fn().mockResolvedValue(undefined),
    saveSession: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn().mockResolvedValue(null),
    deleteSession: vi.fn().mockResolvedValue(undefined),
  },
}))

// ROOT CAUSE:
//
// The leading system message was seeded once at session creation and never
// touched again, so editing the active character card (name, personality,
// system prompt) had no effect on any session that already had history —
// the character kept answering from the stale prompt until the user started
// a brand-new chat.
//
// We fixed this by refreshing the leading system message inside
// ensureSession (which runs on every send) whenever the freshly composed
// prompt differs from the persisted one.
describe('ensureSession system message refresh', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.systemPrompt.value = 'PROMPT A'
  })

  it('seeds a new session with the current card prompt', () => {
    const store = useChatSessionStore()
    store.ensureSession('session-1')

    const messages = store.getSessionMessages('session-1')
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('PROMPT A')
  })

  it('refreshes the stale system message after the card prompt changes (Issue: card edits never reached existing sessions)', () => {
    const store = useChatSessionStore()
    store.ensureSession('session-1')
    store.appendSessionMessage('session-1', { role: 'user', content: 'hello', id: 'm1', createdAt: 1 })

    mocks.systemPrompt.value = 'PROMPT B with 시로하'
    store.ensureSession('session-1')

    const messages = store.getSessionMessages('session-1')
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('PROMPT B with 시로하')
    expect(messages[0].content).not.toContain('PROMPT A')
    expect(messages[1]).toMatchObject({ role: 'user', content: 'hello' })
  })

  it('keeps the message array untouched when the prompt is unchanged (KV-cache stability)', () => {
    const store = useChatSessionStore()
    store.ensureSession('session-1')
    store.appendSessionMessage('session-1', { role: 'user', content: 'hello', id: 'm1', createdAt: 1 })

    const before = store.getSessionMessages('session-1')
    store.ensureSession('session-1')
    const after = store.getSessionMessages('session-1')

    expect(after).toBe(before)
  })
})
