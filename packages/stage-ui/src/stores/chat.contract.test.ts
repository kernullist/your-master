import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { useChatOrchestratorStore } from './chat'

const llmStreamMock = vi.fn()
const trackFirstMessageMock = vi.fn()
const ingestContextMessageMock = vi.fn()
const getContextsSnapshotMock = vi.fn()
const createMinecraftContextMock = vi.fn()
const persistSessionMessagesMock = vi.fn()
const forkSessionMock = vi.fn()
const ensureSessionMock = vi.fn()
const parserConsumeMock = vi.fn()
const parserEndMock = vi.fn()

const activeSessionIdRef = ref('session-1')
const streamingMessageRef = ref<any>({ role: 'assistant', content: '', slices: [], tool_results: [] })
const sessionMessages: Record<string, any[]> = {}
let currentGeneration = 1

vi.mock('pinia', async () => {
  const actual = await vi.importActual<typeof import('pinia')>('pinia')
  return {
    ...actual,
    storeToRefs: (store: any) => store,
  }
})

vi.mock('@proj-airi/stream-kit', () => ({
  createQueue: ({ handlers }: { handlers: Array<(ctx: { data: any }) => Promise<void> | void> }) => {
    const enqueueListeners: Array<(data: any) => void> = []
    const dequeueListeners: Array<(data: any) => void> = []

    return {
      enqueue(data: any) {
        for (const listener of enqueueListeners)
          listener(data)

        queueMicrotask(async () => {
          try {
            for (const handler of handlers) {
              await handler({ data })
            }
          }
          finally {
            for (const listener of dequeueListeners)
              listener(data)
          }
        })
      },
      on(event: 'enqueue' | 'dequeue', listener: (data: any) => void) {
        if (event === 'enqueue') {
          enqueueListeners.push(listener)
          return
        }

        dequeueListeners.push(listener)
      },
    }
  },
}))

vi.mock('../composables', () => ({
  useAnalytics: () => ({
    trackFirstMessage: trackFirstMessageMock,
  }),
}))

vi.mock('../composables/llm-marker-parser', () => ({
  useLlmmarkerParser: (options: { onLiteral?: (literal: string) => Promise<void>, onEnd?: (fullText: string) => Promise<void> }) => {
    let fullText = ''
    return {
      consume: async (textPart: string) => {
        parserConsumeMock(textPart)
        fullText += textPart
        await options.onLiteral?.(textPart)
      },
      end: async () => {
        parserEndMock()
        await options.onEnd?.(fullText)
      },
    }
  },
}))

vi.mock('../composables/response-categoriser', () => ({
  createStreamingCategorizer: () => ({
    consume: vi.fn(),
    filterToSpeech: (literal: string) => literal,
  }),
  categorizeResponse: (fullText: string) => ({
    speech: fullText,
    reasoning: '',
  }),
}))

vi.mock('./chat/context-providers', () => ({
  createMinecraftContext: () => createMinecraftContextMock(),
}))

vi.mock('./chat/context-store', () => ({
  useChatContextStore: () => ({
    ingestContextMessage: ingestContextMessageMock,
    getContextsSnapshot: getContextsSnapshotMock,
  }),
}))

vi.mock('./chat/session-store', () => ({
  useChatSessionStore: () => ({
    activeSessionId: activeSessionIdRef,
    sessionMessages,
    ensureSession: (sessionId: string) => {
      ensureSessionMock(sessionId)
      sessionMessages[sessionId] ??= [{ role: 'system', content: 'system prompt', createdAt: 1, id: 'system' }]
    },
    appendSessionMessage: (sessionId: string, message: any) => {
      sessionMessages[sessionId] ??= []
      sessionMessages[sessionId].push(message)
    },
    getSessionMessages: (sessionId: string) => sessionMessages[sessionId] ?? [],
    persistSessionMessages: persistSessionMessagesMock,
    getSessionGeneration: () => currentGeneration,
    forkSession: forkSessionMock,
  }),
}))

vi.mock('./chat/stream-store', () => ({
  useChatStreamStore: () => ({
    streamingMessage: streamingMessageRef,
  }),
}))

vi.mock('./llm', () => ({
  useLLM: () => ({
    stream: llmStreamMock,
  }),
}))

// ROOT CAUSE:
//
// The orchestrator gained direct dependencies on `useAiriCardStore` and
// `useAutonomousArtistryStore` (artistry autonomy hooks in performSend), but
// this contract test never mocked them. Instantiating the real airi-card
// store calls `useI18n()` at store-setup time, which throws
// "Must be called at the top of a `setup` function" outside a component,
// failing every test in this file.
//
// We fixed this by mocking both module stores with the minimal surface the
// orchestrator touches (`activeCard` lookup and `runArtistTask`).
vi.mock('./modules/airi-card', () => ({
  useAiriCardStore: () => ({
    activeCard: undefined,
  }),
}))

vi.mock('./modules/artistry-autonomous', () => ({
  useAutonomousArtistryStore: () => ({
    runArtistTask: vi.fn(),
  }),
}))

vi.mock('./modules/consciousness', () => ({
  useConsciousnessStore: () => ({
    activeProvider: ref('mock-provider'),
  }),
}))

const provider = {
  chat: () => ({ baseURL: 'https://example.com/' }),
} as unknown as ChatProvider

describe('chat orchestrator contract', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    llmStreamMock.mockReset()
    trackFirstMessageMock.mockReset()
    ingestContextMessageMock.mockReset()
    getContextsSnapshotMock.mockReset()
    createMinecraftContextMock.mockReset()
    createMinecraftContextMock.mockReturnValue(undefined)
    persistSessionMessagesMock.mockReset()
    forkSessionMock.mockReset()
    ensureSessionMock.mockReset()
    parserConsumeMock.mockReset()
    parserEndMock.mockReset()
    activeSessionIdRef.value = 'session-1'
    streamingMessageRef.value = { role: 'assistant', content: '', slices: [], tool_results: [] }
    currentGeneration = 1

    for (const key of Object.keys(sessionMessages)) {
      delete sessionMessages[key]
    }

    sessionMessages['session-1'] = [{ role: 'system', content: 'system prompt', createdAt: 1, id: 'system' }]
  })

  it('keeps hook order and composes context prompt after system message', async () => {
    const contextsSnapshot = {
      'system:weather': [
        {
          id: 'weather',
          contextId: 'system:weather',
          source: 'ReplaceSelf',
          text: 'sunny',
          createdAt: 456,
        },
      ],
    }

    getContextsSnapshotMock.mockReturnValue(contextsSnapshot)

    let composedMessages: Message[] = []
    llmStreamMock.mockImplementation(async (_model: string, _chatProvider: ChatProvider, messages: Message[], options: any) => {
      composedMessages = messages
      expect(options.waitForTools).toBe(true)

      await options.onStreamEvent({ type: 'text-delta', text: 'hello' })
      await options.onStreamEvent({ type: 'finish', finishReason: 'stop' })
    })

    const store = useChatOrchestratorStore()
    const hookOrder: string[] = []

    store.onBeforeMessageComposed(async () => {
      hookOrder.push('before-compose')
    })
    store.onAfterMessageComposed(async () => {
      hookOrder.push('after-compose')
    })
    store.onBeforeSend(async () => {
      hookOrder.push('before-send')
    })
    store.onTokenLiteral(async () => {
      hookOrder.push('token-literal')
    })
    store.onStreamEnd(async () => {
      hookOrder.push('stream-end')
    })
    store.onAssistantResponseEnd(async () => {
      hookOrder.push('assistant-end')
    })
    store.onAfterSend(async () => {
      hookOrder.push('after-send')
    })
    store.onAssistantMessage(async () => {
      hookOrder.push('assistant-message')
    })
    store.onChatTurnComplete(async () => {
      hookOrder.push('turn-complete')
    })

    await store.ingest('hello from user', {
      model: 'gpt-test',
      chatProvider: provider,
    })

    expect(store.sending).toBe(false)
    expect(trackFirstMessageMock).toHaveBeenCalledTimes(1)
    // Datetime is no longer pushed through ingestContextMessage; it is now
    // applied at message-assembly time as a system-prompt anchor + per-message
    // [HH:MM] prefix. ingestContextMessage should still be called for other
    // context providers (e.g. minecraft) when they are configured, but not
    // for datetime in this test (minecraft is mocked to return undefined).
    expect(ingestContextMessageMock).not.toHaveBeenCalled()
    expect(persistSessionMessagesMock).not.toHaveBeenCalled()
    expect(parserConsumeMock).toHaveBeenCalledWith('hello')
    expect(parserEndMock).toHaveBeenCalledTimes(1)
    expect(hookOrder).toEqual([
      'before-compose',
      'after-compose',
      'before-send',
      'token-literal',
      'stream-end',
      'assistant-end',
      'after-send',
      'assistant-message',
      'turn-complete',
    ])

    expect(composedMessages).toHaveLength(2)
    expect(composedMessages[0]).toMatchObject({ role: 'system' })
    expect(composedMessages[1]).toMatchObject({ role: 'user' })

    // System message stays untouched: keeping it 100% static is what makes
    // the prefix permanently KV-cache friendly across turns and across day
    // boundaries (the date now lives inside per-message timestamp prefixes
    // instead of a system anchor).
    const systemContent = (composedMessages[0] as any).content
    const systemText = typeof systemContent === 'string' ? systemContent : systemContent.map((p: any) => p.text).join('')
    expect(systemText).toBe('system prompt')

    // The user turn is prefixed with [YYYY-MM-DD HH:MM]. Both historic and
    // current turns share the same shape so prefix-cache stays valid when a
    // "current" turn becomes "historic" on the next send. Side-channel context
    // (weather) is appended as a separate text part so providers don't see
    // consecutive same-role messages.
    const userMessageContent = (composedMessages[1] as any).content
    expect(userMessageContent[0].text).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] hello from user$/)

    const syntheticContextText = userMessageContent[1].text
    expect(syntheticContextText).not.toContain('<context>')
    expect(syntheticContextText).not.toContain('<module ')
    expect(syntheticContextText).toContain('[Context]')
    expect(syntheticContextText).toContain('- system:weather: sunny')
  })

  it('rejects cancelled queued sends before they start', async () => {
    llmStreamMock.mockImplementation(async () => {
      // keep pending
      await new Promise(() => {})
    })

    const store = useChatOrchestratorStore()
    const pending = store.ingest('cancel me', {
      model: 'gpt-test',
      chatProvider: provider,
    })

    store.cancelPendingSends('session-1')

    await expect(pending).rejects.toThrow('Chat session was reset before send could start')
  })

  it('rejects stale generation sends before performSend starts', async () => {
    const store = useChatOrchestratorStore()
    const pending = store.ingest('stale request', {
      model: 'gpt-test',
      chatProvider: provider,
    })

    currentGeneration = 2

    await expect(pending).rejects.toThrow('Chat session was reset before send could start')
    expect(llmStreamMock).not.toHaveBeenCalled()
  })

  it('uses forked session id in ingestOnFork and keeps public store contract keys', async () => {
    getContextsSnapshotMock.mockReturnValue({})
    forkSessionMock.mockResolvedValue('session-forked')
    llmStreamMock.mockImplementation(async (_model: string, _chatProvider: ChatProvider, _messages: Message[], options: any) => {
      await options.onStreamEvent({ type: 'text-delta', text: 'fork-reply' })
      await options.onStreamEvent({ type: 'finish', finishReason: 'stop' })
    })

    const store = useChatOrchestratorStore()

    expect(store.$id).toBe('chat-orchestrator')
    expect(typeof store.ingest).toBe('function')
    expect(typeof store.ingestOnFork).toBe('function')
    expect(typeof store.cancelPendingSends).toBe('function')
    expect(typeof store.onBeforeSend).toBe('function')
    expect(typeof store.emitBeforeSendHooks).toBe('function')

    await store.ingestOnFork('fork me', {
      model: 'gpt-test',
      chatProvider: provider,
    }, {
      fromSessionId: 'session-1',
      atIndex: 3,
      reason: 'retry',
      hidden: true,
    })

    expect(forkSessionMock).toHaveBeenCalledWith({
      fromSessionId: 'session-1',
      atIndex: 3,
      reason: 'retry',
      hidden: true,
    })
    expect(ensureSessionMock).toHaveBeenCalledWith('session-forked')
  })

  // ROOT CAUSE:
  //
  // Reasoning models (e.g. Qwen thinking variants on LM Studio) stream their
  // output as `reasoning-delta` events (`delta.reasoning_content`) long
  // before the first `text-delta`. The orchestrator's onStreamEvent switch
  // had no case for them, so the UI stayed completely blank for the whole
  // reasoning phase and the turn looked like a hang.
  //
  // We fixed this by accumulating reasoning deltas into
  // `buildingMessage.categorization.reasoning` (rendered live by the
  // collapsible reasoning section) and merging it with the tag-based
  // categorization at finalize so it is not wiped.
  it('streams native reasoning into categorization and keeps it after finalize', async () => {
    getContextsSnapshotMock.mockReturnValue({})
    llmStreamMock.mockImplementation(async (_model: string, _chatProvider: ChatProvider, _messages: Message[], options: any) => {
      await options.onStreamEvent({ type: 'reasoning-delta', text: 'thinking hard about it ' })
      await options.onStreamEvent({ type: 'reasoning-delta', text: 'and even harder now...' })
      await options.onStreamEvent({ type: 'text-delta', text: 'hello!' })
      await options.onStreamEvent({ type: 'finish', finishReason: 'stop' })
    })

    const store = useChatOrchestratorStore()
    await store.ingest('hi', { model: 'gpt-test', chatProvider: provider })

    const appended = sessionMessages['session-1'].at(-1)
    expect(appended.role).toBe('assistant')
    expect(appended.slices).toEqual([{ type: 'text', text: 'hello!' }])
    expect(appended.categorization.speech).toBe('hello!')
    expect(appended.categorization.reasoning).toBe('thinking hard about it and even harder now...')
  })

  // ROOT CAUSE:
  //
  // When a model spent its entire output on reasoning and produced no reply
  // content, `buildingMessage.slices` stayed empty, the persist guard
  // (`slices.length > 0`) skipped the append, and the whole turn vanished
  // without a trace — indistinguishable from a hang for the user.
  //
  // We fixed this by persisting the reasoning-only message with a visible
  // notice slice, and by appending a retriable error item when the stream
  // was completely empty.
  it('persists a reasoning-only turn with a visible notice instead of dropping it', async () => {
    getContextsSnapshotMock.mockReturnValue({})
    llmStreamMock.mockImplementation(async (_model: string, _chatProvider: ChatProvider, _messages: Message[], options: any) => {
      await options.onStreamEvent({ type: 'reasoning-delta', text: 'pondering forever' })
      await options.onStreamEvent({ type: 'finish', finishReason: 'stop' })
    })

    const store = useChatOrchestratorStore()
    await store.ingest('hi', { model: 'gpt-test', chatProvider: provider })

    const appended = sessionMessages['session-1'].at(-1)
    expect(appended.role).toBe('assistant')
    expect(appended.slices).toHaveLength(1)
    expect(appended.slices[0].type).toBe('text')
    expect(appended.slices[0].text).toContain('응답 본문 없이')
    expect(appended.categorization.reasoning).toBe('pondering forever')
  })

  it('appends a retriable error item when the model returns an empty stream', async () => {
    getContextsSnapshotMock.mockReturnValue({})
    llmStreamMock.mockImplementation(async (_model: string, _chatProvider: ChatProvider, _messages: Message[], options: any) => {
      await options.onStreamEvent({ type: 'finish', finishReason: 'stop' })
    })

    const store = useChatOrchestratorStore()
    await store.ingest('hi', { model: 'gpt-test', chatProvider: provider })

    const appended = sessionMessages['session-1'].at(-1)
    expect(appended.role).toBe('error')
    expect(appended.content).toContain('빈 응답')
  })
})
