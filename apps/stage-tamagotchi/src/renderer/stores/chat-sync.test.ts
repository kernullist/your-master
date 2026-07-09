import type { Ref } from 'vue'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'

interface MockBroadcastMessageEvent<T> {
  data: T
}

type MockListener = (event: MockBroadcastMessageEvent<unknown>) => void

class MockBroadcastChannel {
  static channels = new Map<string, Set<MockBroadcastChannel>>()

  static reset() {
    for (const peers of MockBroadcastChannel.channels.values()) {
      for (const peer of peers)
        peer.listeners.clear()
    }
    MockBroadcastChannel.channels.clear()
  }

  readonly name: string
  private readonly listeners = new Set<MockListener>()

  constructor(name: string) {
    this.name = name
    if (!MockBroadcastChannel.channels.has(name))
      MockBroadcastChannel.channels.set(name, new Set())
    MockBroadcastChannel.channels.get(name)?.add(this)
  }

  addEventListener(_type: 'message', listener: EventListener) {
    this.listeners.add(listener as unknown as MockListener)
  }

  removeEventListener(_type: 'message', listener: EventListener) {
    this.listeners.delete(listener as unknown as MockListener)
  }

  postMessage(data: unknown) {
    const peers = MockBroadcastChannel.channels.get(this.name)
    if (!peers)
      return

    for (const peer of peers) {
      if (peer === this)
        continue

      for (const listener of peer.listeners)
        listener({ data })
    }
  }

  close() {
    const peers = MockBroadcastChannel.channels.get(this.name)
    peers?.delete(this)
    this.listeners.clear()
    if (peers && peers.size === 0)
      MockBroadcastChannel.channels.delete(this.name)
  }
}

interface MockState {
  activeSessionId: Ref<string>
  sessionMessages: Ref<Record<string, Array<{ role: string, content: string }>>>
  sessionMetas: Ref<Record<string, unknown>>
  applyRemoteSnapshot: ReturnType<typeof vi.fn>
  setSessionMessages: ReturnType<typeof vi.fn>
  appendSessionMessage: ReturnType<typeof vi.fn>
  getSessionMessages: ReturnType<typeof vi.fn>
  ingest: ReturnType<typeof vi.fn>
}

let mockState: MockState
const mockElectronEventa = vi.hoisted(() => {
  const eventHandlers = new Set<(event: { body?: unknown }) => void>()
  const getElectronEventaContext = vi.fn(() => ({
    on: vi.fn((_event: unknown, handler: (event: { body?: unknown }) => void) => {
      eventHandlers.add(handler)
      return () => {
        eventHandlers.delete(handler)
      }
    }),
  }))

  return {
    eventHandlers,
    getElectronEventaContext,
  }
})
const mockProjectManagement = vi.hoisted(() => ({
  executeProjectManagementAction: vi.fn(async () => 'Opened project board in external browser.'),
  projectManagementTools: vi.fn(async () => []),
}))

vi.mock('@proj-airi/electron-vueuse', () => ({
  getElectronEventaContext: mockElectronEventa.getElectronEventaContext,
}))

vi.mock('@proj-airi/stage-ui/stores/chat/session-store', () => ({
  useChatSessionStore: () => ({
    activeSessionId: mockState.activeSessionId,
    sessionMessages: mockState.sessionMessages,
    sessionMetas: mockState.sessionMetas,
    applyRemoteSnapshot: mockState.applyRemoteSnapshot,
    getSnapshot: vi.fn(() => ({
      activeSessionId: mockState.activeSessionId.value,
      sessionMessages: mockState.sessionMessages.value,
      sessionMetas: mockState.sessionMetas.value,
    })),
    getSessionMessages: mockState.getSessionMessages,
    setSessionMessages: mockState.setSessionMessages,
    appendSessionMessage: mockState.appendSessionMessage,
  }),
}))

vi.mock('@proj-airi/stage-ui/stores/chat/stream-store', () => ({
  useChatStreamStore: () => ({
    streamingMessage: ref({ role: 'assistant', content: '', slices: [], tool_results: [] }),
  }),
}))

vi.mock('@proj-airi/stage-ui/stores/chat', () => ({
  useChatOrchestratorStore: () => ({
    sending: ref(false),
    ingest: mockState.ingest,
  }),
}))

vi.mock('@proj-airi/stage-ui/stores/chat/maintenance', () => ({
  useChatMaintenanceStore: () => ({
    cleanupMessages: vi.fn(),
  }),
}))

vi.mock('@proj-airi/stage-ui/stores/providers', () => ({
  useProvidersStore: () => ({
    getProviderInstance: vi.fn(async () => ({ id: 'provider' })),
  }),
}))

vi.mock('@proj-airi/stage-ui/stores/modules/consciousness', () => ({
  useConsciousnessStore: () => ({
    activeProvider: computed(() => 'provider-id'),
    activeModel: computed(() => 'model-id'),
  }),
}))

vi.mock('./tools/builtin/widgets', () => ({
  widgetsTools: vi.fn(async () => []),
}))

vi.mock('./tools/builtin/weather', () => ({
  weatherTools: vi.fn(async () => []),
}))

vi.mock('./tools/builtin/project-management', () => ({
  executeProjectManagementAction: mockProjectManagement.executeProjectManagementAction,
  projectManagementTools: mockProjectManagement.projectManagementTools,
}))

/**
 * @example
 * describe('useChatSyncStore authority ingest failures', () => {
 *   it('persists ingest errors into authoritative session snapshot', async () => {})
 * })
 */
describe('useChatSyncStore authority ingest failures', async () => {
  const {
    extractProjectWorkItemStartIdentifier,
    formatChatCommandFailureMessage,
    isProjectProgressRequest,
    formatProjectWorkItemStatusNotification,
    isTodoWorkItemListRequest,
    resolveProjectProgressStatus,
    useChatSyncStore,
  } = await import('./chat-sync')

  beforeEach(() => {
    setActivePinia(createPinia())
    MockBroadcastChannel.reset()

    const activeSessionId = ref('session-1')
    const sessionMessages = ref<Record<string, Array<{ role: string, content: string }>>>({
      'session-1': [{ role: 'system', content: 'init' }],
    })
    const sessionMetas = ref<Record<string, unknown>>({})
    const applyRemoteSnapshot = vi.fn((snapshot: {
      activeSessionId: string
      sessionMessages: Record<string, Array<{ role: string, content: string }>>
      sessionMetas: Record<string, unknown>
    }) => {
      activeSessionId.value = snapshot.activeSessionId
      sessionMessages.value = snapshot.sessionMessages
      sessionMetas.value = snapshot.sessionMetas
    })

    const setSessionMessages = vi.fn((sessionId: string, next: Array<{ role: string, content: string }>) => {
      sessionMessages.value[sessionId] = next
    })
    const appendSessionMessage = vi.fn((sessionId: string, message: { role: string, content: string }) => {
      sessionMessages.value[sessionId] = [
        ...(sessionMessages.value[sessionId] ?? []),
        message,
      ]
    })

    const getSessionMessages = vi.fn((sessionId: string) => sessionMessages.value[sessionId] ?? [])

    const ingest = vi.fn(async () => {
      throw new Error('Remote sent 403 response: {"error":{"message":"This model is not available in your region.","code":403}}')
    })

    mockState = {
      activeSessionId,
      sessionMessages,
      sessionMetas,
      applyRemoteSnapshot,
      setSessionMessages,
      appendSessionMessage,
      getSessionMessages,
      ingest,
    }

    mockProjectManagement.executeProjectManagementAction.mockReset()
    mockProjectManagement.executeProjectManagementAction.mockResolvedValue('Opened project board in external browser.')
    mockElectronEventa.eventHandlers.clear()
    mockElectronEventa.getElectronEventaContext.mockClear()
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    MockBroadcastChannel.reset()
  })

  /**
   * @example
   * it('keeps region-availability errors visible for follower windows', async () => {
   *   // authority receives ingest command failure
   *   // authoritative session gets role:error entry
   * })
   */
  it('stores command ingest errors in authority session history', async () => {
    const store = useChatSyncStore()
    store.initialize('authority')

    const peer = new MockBroadcastChannel('airi:stage-tamagotchi:chat-sync')
    peer.postMessage({
      type: 'command',
      requestId: 'req-1',
      senderId: 'peer',
      command: 'ingest',
      payload: {
        text: 'hello',
        sessionId: 'session-1',
      },
    })

    await vi.waitFor(() => {
      expect(mockState.ingest).toHaveBeenCalledTimes(1)
      expect(mockState.setSessionMessages).toHaveBeenCalledTimes(1)
    })

    const persistedMessages = mockState.sessionMessages.value['session-1']
    expect(persistedMessages).toHaveLength(2)
    expect(persistedMessages[1]?.role).toBe('error')
    expect(persistedMessages[1]?.content).toContain('요청을 처리하지 못했어')
    expect(persistedMessages[1]?.content).toContain('This model is not available in your region')

    peer.close()
    store.dispose()
  })

  /**
   * @example
   * it('resolves authority ingest failures after the user turn is accepted', async () => {
   *   // accepted user turns should stay in history
   *   // the input draft should not be restored by callers
   * })
   */
  it('resolves authority ingest failures after the user turn is accepted', async () => {
    mockState.ingest.mockImplementationOnce(async (text: string, _options: unknown, sessionId?: string) => {
      const targetSessionId = sessionId ?? mockState.activeSessionId.value
      mockState.sessionMessages.value[targetSessionId] = [
        ...(mockState.sessionMessages.value[targetSessionId] ?? []),
        {
          role: 'user',
          content: text,
        },
      ]
      throw new Error('stream interrupted')
    })

    const store = useChatSyncStore()
    store.initialize('authority')

    await expect(store.requestIngest({
      text: 'hello',
      sessionId: 'session-1',
    })).resolves.toBeUndefined()

    expect(mockState.setSessionMessages).toHaveBeenCalledWith('session-1', [
      { role: 'system', content: 'init' },
      { role: 'user', content: 'hello' },
      {
        role: 'error',
        content: '요청을 처리하지 못했어.\n원인: stream interrupted',
      },
    ])

    store.dispose()
  })

  /**
   * @example
   * it('resolves follower ingest requests when the authority accepted the user turn', async () => {
   *   // follower input should stay cleared
   *   // authority still records the failure in chat history
   * })
   */
  it('resolves follower ingest requests when the authority accepted the user turn', async () => {
    mockState.ingest.mockImplementationOnce(async (text: string, _options: unknown, sessionId?: string) => {
      const targetSessionId = sessionId ?? mockState.activeSessionId.value
      mockState.sessionMessages.value[targetSessionId] = [
        ...(mockState.sessionMessages.value[targetSessionId] ?? []),
        {
          role: 'user',
          content: text,
        },
      ]
      throw new Error('stream interrupted')
    })

    setActivePinia(createPinia())
    const authorityStore = useChatSyncStore()
    authorityStore.initialize('authority')

    setActivePinia(createPinia())
    const followerStore = useChatSyncStore()
    followerStore.initialize('follower')

    await expect(followerStore.requestIngest({
      text: 'hello',
      sessionId: 'session-1',
    })).resolves.toBeUndefined()

    expect(mockState.setSessionMessages).toHaveBeenCalledWith('session-1', [
      { role: 'system', content: 'init' },
      { role: 'user', content: 'hello' },
      {
        role: 'error',
        content: '요청을 처리하지 못했어.\n원인: stream interrupted',
      },
    ])

    followerStore.dispose()
    authorityStore.dispose()
  })

  // Internal report (꿀보, chat): a long-reasoning question times out and the
  // typed question reappears in the input box even though it was accepted.
  /**
   * @example
   * it('acks follower ingest on acceptance without awaiting a slow turn', async () => {
   *   // follower input stays cleared while the authority keeps reasoning
   *   // the request resolves well before the 30s dispatchCommand timeout
   * })
   */
  it('acks follower ingest on acceptance without awaiting a slow turn', async () => {
    // ROOT CAUSE:
    //
    // The follower window (pages/chat.vue) dispatches ingest over
    // dispatchCommand, which rejects after REQUEST_TIMEOUT_MS (30s). The
    // authority only responded after the FULL turn finished, but a
    // long-reasoning turn runs up to TURN_WATCHDOG_MS (180s) > 30s. So the
    // follower timed out locally and InteractiveArea.handleSend restored the
    // user's input draft, even though the message was accepted and streaming.
    //
    // <before-patch behavior>
    // handleCommand: await executeIngest(...) then respond(true) // blocks 30s+
    //
    // We fixed this by acking the ingest command at the acceptance point (the
    // user message landed in history) instead of turn completion.
    // <after-patch behavior>
    // handleIngestCommand: respond(true,{ingestAccepted}) once accepted; the
    // turn keeps running and streams to the follower via broadcasts.

    let releaseTurn = () => {}
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    // The turn accepts immediately (user message lands) but keeps running far
    // longer than REQUEST_TIMEOUT_MS, simulating heavy reasoning.
    mockState.ingest.mockImplementationOnce(async (text: string, _options: unknown, sessionId?: string) => {
      const targetSessionId = sessionId ?? mockState.activeSessionId.value
      mockState.sessionMessages.value[targetSessionId] = [
        ...(mockState.sessionMessages.value[targetSessionId] ?? []),
        {
          role: 'user',
          content: text,
        },
      ]
      await turnGate
    })

    setActivePinia(createPinia())
    const authorityStore = useChatSyncStore()
    authorityStore.initialize('authority')

    setActivePinia(createPinia())
    const followerStore = useChatSyncStore()
    followerStore.initialize('follower')

    // Resolves on acceptance; without the fix this would hang until the turn
    // finishes (turnGate is still pending here) and then reject at 30s.
    await expect(followerStore.requestIngest({
      text: 'why is the sky blue, think hard',
      sessionId: 'session-1',
    })).resolves.toBeUndefined()

    const persisted = mockState.sessionMessages.value['session-1']
    expect(persisted.at(-1)).toEqual({ role: 'user', content: 'why is the sky blue, think hard' })
    expect(persisted.some(message => message.role === 'error')).toBe(false)

    // Let the simulated turn complete cleanly before teardown.
    releaseTurn()
    await turnGate

    followerStore.dispose()
    authorityStore.dispose()
  })

  /**
   * @example
   * it('formats tool and model failures for users', () => {
   *   // raw tool/model errors should not appear as context-free failures
   * })
   */
  it('formats command failures for user-visible chat errors', () => {
    expect(formatChatCommandFailureMessage('Tool "stage_project_management" execution failed.')).toBe('요청을 처리하지 못했어.\n원인: Tool "stage_project_management" execution failed.')
  })

  /**
   * @example
   * it('formats terminal project work item status notifications for chat', () => {
   *   // done and blocked status changes should become assistant messages
   * })
   */
  it('formats terminal project work item status notifications for chat', () => {
    expect(formatProjectWorkItemStatusNotification({
      previousStatus: 'in_review',
      workItem: {
        identifier: 'AIRI-12',
        status: 'done',
        title: 'Add project board',
      },
    })).toContain('AIRI-12 일감이 완료됐어.')

    expect(formatProjectWorkItemStatusNotification({
      previousStatus: 'in_progress',
      workItem: {
        identifier: 'AIRI-13',
        status: 'blocked',
        title: 'Wire runner',
      },
    })).toContain('AIRI-13 일감이 블락됐어.')

    expect(formatProjectWorkItemStatusNotification({
      previousStatus: 'todo',
      workItem: {
        identifier: 'AIRI-14',
        status: 'in_progress',
        title: 'Start work',
      },
    })).toBeNull()
  })

  /**
   * @example
   * it('appends a chat notification when a project work item reaches done or blocked', async () => {
   *   // project-management status events should reach the active chat session
   * })
   */
  it('appends chat notifications for done and blocked project work items', async () => {
    const store = useChatSyncStore()
    store.initialize('authority')

    const [handler] = [...mockElectronEventa.eventHandlers]
    expect(handler).toBeDefined()

    handler?.({
      body: {
        previousStatus: 'in_review',
        workItem: {
          identifier: 'AIRI-12',
          status: 'done',
          title: 'Add project board',
        },
      },
    })

    expect(mockState.appendSessionMessage).toHaveBeenCalledWith('session-1', {
      role: 'assistant',
      content: expect.stringContaining('AIRI-12 일감이 완료됐어.'),
      slices: [{
        type: 'text',
        text: expect.stringContaining('AIRI-12 일감이 완료됐어.'),
      }],
      tool_results: [],
      createdAt: expect.any(Number),
    })

    handler?.({
      body: {
        previousStatus: 'in_progress',
        workItem: {
          identifier: 'AIRI-13',
          status: 'blocked',
          title: 'Wire runner',
        },
      },
    })

    expect(mockState.appendSessionMessage).toHaveBeenCalledWith('session-1', {
      role: 'assistant',
      content: expect.stringContaining('AIRI-13 일감이 블락됐어.'),
      slices: [{
        type: 'text',
        text: expect.stringContaining('AIRI-13 일감이 블락됐어.'),
      }],
      tool_results: [],
      createdAt: expect.any(Number),
    })

    store.dispose()
  })

  /**
   * @example
   * it('does not notify chat for non-terminal project status changes', () => {
   *   // in_progress and in_review are too noisy for chat notifications
   * })
   */
  it('does not notify chat for non-terminal project status changes', () => {
    const store = useChatSyncStore()
    store.initialize('authority')

    const [handler] = [...mockElectronEventa.eventHandlers]
    handler?.({
      body: {
        previousStatus: 'todo',
        workItem: {
          identifier: 'AIRI-12',
          status: 'in_progress',
          title: 'Add project board',
        },
      },
    })

    expect(mockState.appendSessionMessage).not.toHaveBeenCalled()

    store.dispose()
  })

  /**
   * @example
   * it('opens the project board directly without asking the LLM to call tools', async () => {
   *   // clear project-board requests append a user/assistant pair
   *   // chat model ingest is skipped so weak tool-calling models cannot leak JSON
   * })
   */
  it('opens project board requests through the local command shortcut', async () => {
    const store = useChatSyncStore()
    store.initialize('authority')

    await store.requestIngest({
      text: '프로젝트 보드 열어줘',
      sessionId: 'session-1',
    })

    expect(mockState.ingest).not.toHaveBeenCalled()
    expect(mockState.appendSessionMessage).toHaveBeenCalledWith('session-1', {
      role: 'user',
      content: '프로젝트 보드 열어줘',
    })
    expect(mockState.appendSessionMessage).toHaveBeenCalledWith('session-1', {
      role: 'assistant',
      content: '프로젝트 보드를 별도 브라우저로 열었어.',
      slices: [{ type: 'text', text: '프로젝트 보드를 별도 브라우저로 열었어.' }],
      tool_results: [],
    })

    store.dispose()
  })

  /**
   * @example
   * it('extracts direct work item start requests', () => {
   *   // "AIRI-12 진행해줘" should bypass weak LLM tool calling
   * })
   */
  it('extracts direct work item start requests', () => {
    expect(extractProjectWorkItemStartIdentifier('AIRI-12 진행해줘')).toBe('AIRI-12')
    expect(extractProjectWorkItemStartIdentifier('airi-12 start')).toBe('AIRI-12')
    expect(extractProjectWorkItemStartIdentifier('AIRI-12 상태 알려줘')).toBeNull()
  })

  /**
   * @example
   * it('detects direct TODO work item list requests', () => {
   *   // "현재 todo 일감들을 알려줘" should bypass weak LLM tool calling
   * })
   */
  it('detects direct TODO work item list requests', () => {
    expect(isTodoWorkItemListRequest('현재 todo 일감들을 알려줘')).toBe(true)
    expect(isTodoWorkItemListRequest('TODO 작업 목록 보여줘')).toBe(true)
    expect(isTodoWorkItemListRequest('AIRI-12 상태 알려줘')).toBe(false)
  })

  /**
   * @example
   * it('detects progress questions without treating starts as status requests', () => {
   *   // "AIRI-12 진행상황 알려줘" is read-only
   *   // "AIRI-12 진행해줘" starts work
   * })
   */
  it('detects project progress questions without catching start commands', () => {
    expect(isProjectProgressRequest('프로젝트 진행상황 알려줘')).toBe(true)
    expect(isProjectProgressRequest('현재 작업 현황 보여줘')).toBe(true)
    expect(isProjectProgressRequest('AIRI-12 상태 알려줘')).toBe(true)
    expect(isProjectProgressRequest('리뷰 중인 작업 뭐야?')).toBe(true)
    expect(isProjectProgressRequest('막힌 일감 있어?')).toBe(true)
    expect(isProjectProgressRequest('AIRI-12 진행해줘')).toBe(false)
    expect(isProjectProgressRequest('네 상태 어때?')).toBe(false)
    expect(extractProjectWorkItemStartIdentifier('AIRI-12 진행상황 알려줘')).toBeNull()
    expect(extractProjectWorkItemStartIdentifier('AIRI-12 진행해줘')).toBe('AIRI-12')
  })

  /**
   * @example
   * it('resolves progress status filters from user wording', () => {
   *   // blocked/review/done wording should focus the summary
   * })
   */
  it('resolves project progress status filters from user wording', () => {
    expect(resolveProjectProgressStatus('막힌 일감 있어?')).toBe('blocked')
    expect(resolveProjectProgressStatus('리뷰 중인 작업 뭐야?')).toBe('in_review')
    expect(resolveProjectProgressStatus('완료된 작업 알려줘')).toBe('done')
    expect(resolveProjectProgressStatus('진행 중인 작업 알려줘')).toBe('in_progress')
    expect(resolveProjectProgressStatus('todo 작업 목록')).toBe('todo')
  })

  /**
   * @example
   * it('answers project progress through the local project-management shortcut', async () => {
   *   // clear progress questions should not rely on weak model tool calling
   * })
   */
  it('answers project progress through the local project-management shortcut', async () => {
    mockProjectManagement.executeProjectManagementAction.mockResolvedValueOnce('demo 진행상황: 1/3 완료')

    const store = useChatSyncStore()
    store.initialize('authority')

    await store.requestIngest({
      text: 'AIRI-12 상태 알려줘',
      sessionId: 'session-1',
    })

    expect(mockState.ingest).not.toHaveBeenCalled()
    expect(mockProjectManagement.executeProjectManagementAction).toHaveBeenCalledWith({
      action: 'summarize_progress',
      identifier: 'AIRI-12',
      status: undefined,
    })
    expect(mockState.appendSessionMessage).toHaveBeenCalledWith('session-1', {
      role: 'assistant',
      content: 'demo 진행상황: 1/3 완료',
      slices: [{ type: 'text', text: 'demo 진행상황: 1/3 완료' }],
      tool_results: [],
    })

    store.dispose()
  })

  /**
   * @example
   * it('focuses blocked progress questions on blocked items', async () => {
   *   // "막힌 일감" should pass status=blocked into summarize_progress
   * })
   */
  it('focuses blocked progress questions on blocked items', async () => {
    mockProjectManagement.executeProjectManagementAction.mockResolvedValueOnce('막힘 일감: 1개')

    const store = useChatSyncStore()
    store.initialize('authority')

    await store.requestIngest({
      text: '막힌 일감 있어?',
      sessionId: 'session-1',
    })

    expect(mockProjectManagement.executeProjectManagementAction).toHaveBeenCalledWith({
      action: 'summarize_progress',
      identifier: null,
      status: 'blocked',
    })

    store.dispose()
  })

  /**
   * @example
   * it('lists TODO work items through the local command shortcut', async () => {
   *   // clear TODO-list requests append a user/assistant pair
   *   // chat model ingest is skipped so AIRI can answer immediately
   * })
   */
  it('lists TODO work items through the local command shortcut', async () => {
    mockProjectManagement.executeProjectManagementAction.mockResolvedValueOnce('- BC-1: Change theme (todo)')

    const store = useChatSyncStore()
    store.initialize('authority')

    await store.requestIngest({
      text: '현재 todo 일감들을 알려줘',
      sessionId: 'session-1',
    })

    expect(mockState.ingest).not.toHaveBeenCalled()
    expect(mockProjectManagement.executeProjectManagementAction).toHaveBeenCalledWith({
      action: 'list_work_items',
      status: 'todo',
    })
    expect(mockState.appendSessionMessage).toHaveBeenCalledWith('session-1', {
      role: 'assistant',
      content: '현재 TODO 일감은:\n- BC-1: Change theme (todo)',
      slices: [{ type: 'text', text: '현재 TODO 일감은:\n- BC-1: Change theme (todo)' }],
      tool_results: [],
    })

    store.dispose()
  })

  /**
   * @example
   * it('starts TODO work items through the local command shortcut', async () => {
   *   // clear project work requests append a user/assistant pair
   *   // chat model ingest is skipped so AIRI can start work immediately
   * })
   */
  it('starts TODO work items through the local command shortcut', async () => {
    mockProjectManagement.executeProjectManagementAction.mockResolvedValueOnce('AIRI-12 작업을 시작했어. 상태를 in_progress로 바꿨어.')

    const store = useChatSyncStore()
    store.initialize('authority')

    await store.requestIngest({
      text: 'AIRI-12 진행해줘',
      sessionId: 'session-1',
    })

    expect(mockState.ingest).not.toHaveBeenCalled()
    expect(mockProjectManagement.executeProjectManagementAction).toHaveBeenCalledWith({
      action: 'start_work_item',
      identifier: 'AIRI-12',
    })
    expect(mockState.appendSessionMessage).toHaveBeenCalledWith('session-1', {
      role: 'assistant',
      content: 'AIRI-12 작업을 시작했어. 상태를 in_progress로 바꿨어.',
      slices: [{ type: 'text', text: 'AIRI-12 작업을 시작했어. 상태를 in_progress로 바꿨어.' }],
      tool_results: [],
    })

    store.dispose()
  })

  /**
   * @example
   * it('asks for missing work item details before starting', async () => {
   *   // main process can reject start with a clarification message
   *   // chat shortcut surfaces that question directly to the user
   * })
   */
  it('asks for missing work item details before starting through the local command shortcut', async () => {
    mockProjectManagement.executeProjectManagementAction.mockResolvedValueOnce('AIRI-12를 시작하기 전에 목표와 완료 조건이 필요해. 목표와 완료 조건을 알려줘.')

    const store = useChatSyncStore()
    store.initialize('authority')

    await store.requestIngest({
      text: 'AIRI-12 작업 시작해줘',
      sessionId: 'session-1',
    })

    expect(mockState.ingest).not.toHaveBeenCalled()
    expect(mockState.appendSessionMessage).toHaveBeenCalledWith('session-1', {
      role: 'assistant',
      content: 'AIRI-12를 시작하기 전에 목표와 완료 조건이 필요해. 목표와 완료 조건을 알려줘.',
      slices: [{ type: 'text', text: 'AIRI-12를 시작하기 전에 목표와 완료 조건이 필요해. 목표와 완료 조건을 알려줘.' }],
      tool_results: [],
    })

    store.dispose()
  })

  /**
   * @example
   * it('replaces the last failed turn before retrying', async () => {
   *   // authority receives retry command for trailing user -> error pair
   *   // authoritative session removes that failed turn before re-ingesting the user text
   * })
   */
  it('replaces the last failed turn before retrying', async () => {
    mockState.sessionMessages.value['session-1'] = [
      { role: 'system', content: 'init' },
      { role: 'user', content: 'hello-1' },
      { role: 'assistant', content: 'answer-1' },
      { role: 'user', content: 'hello' },
      { role: 'error', content: 'Remote sent 400 response' },
      { role: 'user', content: 'hello-3' },
      { role: 'assistant', content: 'answer-3' },
    ]
    mockState.ingest.mockResolvedValueOnce(undefined)

    const store = useChatSyncStore()
    store.initialize('authority')

    const peer = new MockBroadcastChannel('airi:stage-tamagotchi:chat-sync')
    peer.postMessage({
      type: 'command',
      requestId: 'req-2',
      senderId: 'peer',
      command: 'retry',
      payload: {
        sessionId: 'session-1',
        index: 4,
      },
    })

    await vi.waitFor(() => {
      expect(mockState.setSessionMessages).toHaveBeenCalledWith('session-1', [
        { role: 'system', content: 'init' },
        { role: 'user', content: 'hello-1' },
        { role: 'assistant', content: 'answer-1' },
      ])
      expect(mockState.ingest).toHaveBeenCalledWith('hello', expect.any(Object), 'session-1')
    })

    const persistedMessages = mockState.sessionMessages.value['session-1']
    expect(persistedMessages).toEqual([
      { role: 'system', content: 'init' },
      { role: 'user', content: 'hello-1' },
      { role: 'assistant', content: 'answer-1' },
    ])

    peer.close()
    store.dispose()
  })

  /**
   * @example
   * it('rewinds from the source user turn when retry targets an assistant message', async () => {
   *   // future assistant retry still trims the whole tail from its originating user turn
   * })
   */
  it('rewinds from the source user turn when retry targets an assistant message', async () => {
    mockState.sessionMessages.value['session-1'] = [
      { role: 'system', content: 'init' },
      { role: 'user', content: 'hello-1' },
      { role: 'assistant', content: 'answer-1' },
      { role: 'user', content: 'hello-2' },
      { role: 'assistant', content: 'answer-2' },
      { role: 'user', content: 'hello-3' },
    ]
    mockState.ingest.mockResolvedValueOnce(undefined)

    const store = useChatSyncStore()
    store.initialize('authority')

    const peer = new MockBroadcastChannel('airi:stage-tamagotchi:chat-sync')
    peer.postMessage({
      type: 'command',
      requestId: 'req-3',
      senderId: 'peer',
      command: 'retry',
      payload: {
        sessionId: 'session-1',
        index: 4,
      },
    })

    await vi.waitFor(() => {
      expect(mockState.setSessionMessages).toHaveBeenCalledWith('session-1', [
        { role: 'system', content: 'init' },
        { role: 'user', content: 'hello-1' },
        { role: 'assistant', content: 'answer-1' },
      ])
      expect(mockState.ingest).toHaveBeenCalledWith('hello-2', expect.any(Object), 'session-1')
    })

    peer.close()
    store.dispose()
  })

  /**
   * @example
   * it('keeps the follower chat window on its local session while applying remote snapshots', async () => {
   *   // follower already displays session-2
   *   // authority snapshot arrives with session-1 as active
   *   // follower keeps session-2 selected but still receives session-2 message updates
   * })
   */
  it('keeps the follower chat window on its local session while applying remote snapshots', async () => {
    mockState.activeSessionId.value = 'session-2'
    mockState.sessionMessages.value = {
      'session-2': [{ role: 'system', content: 'chat-window' }],
    }

    const store = useChatSyncStore()
    store.initialize('follower')

    const authority = new MockBroadcastChannel('airi:stage-tamagotchi:chat-sync')
    authority.postMessage({
      type: 'session-snapshot',
      authorityId: 'authority',
      snapshot: {
        activeSessionId: 'session-1',
        sessionMessages: {
          'session-1': [{ role: 'system', content: 'main-window' }],
          'session-2': [{ role: 'system', content: 'chat-window' }, { role: 'user', content: 'retry me' }],
        },
        sessionMetas: {},
      },
    })

    await vi.waitFor(() => {
      expect(mockState.applyRemoteSnapshot).toHaveBeenCalledTimes(1)
    })

    expect(mockState.activeSessionId.value).toBe('session-2')
    expect(mockState.sessionMessages.value['session-2']).toEqual([
      { role: 'system', content: 'chat-window' },
      { role: 'user', content: 'retry me' },
    ])

    authority.close()
    store.dispose()
  })
})
