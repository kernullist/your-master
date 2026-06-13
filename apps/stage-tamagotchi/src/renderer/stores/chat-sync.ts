import type { WebSocketEventInputs } from '@proj-airi/server-sdk'
import type { WorkItem, WorkItemStatus } from '@proj-airi/stage-projects'
import type { ChatHistoryItem, StreamingAssistantMessage } from '@proj-airi/stage-ui/types/chat'
import type { ChatSessionMeta } from '@proj-airi/stage-ui/types/chat-session'
import type { ChatProvider } from '@xsai-ext/providers/utils'

import { errorMessageFrom } from '@moeru/std'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatMaintenanceStore } from '@proj-airi/stage-ui/stores/chat/maintenance'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useChatStreamStore } from '@proj-airi/stage-ui/stores/chat/stream-store'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { defineStore, storeToRefs } from 'pinia'
import { ref, watch } from 'vue'

import { projectManagementWorkItemStatusChanged } from '../../shared/eventa'
import { calculatorTools } from './tools/builtin/calculator'
import { commandExecTools } from './tools/builtin/command-exec'
import { dailyBriefingTools } from './tools/builtin/daily-briefing'
import { desktopIoTools } from './tools/builtin/desktop-io'
import { fileAccessTools } from './tools/builtin/file-access'
import { imageJournalTools } from './tools/builtin/image-journal'
import { memoryTools } from './tools/builtin/memory'
import { executeProjectManagementAction, projectManagementTools } from './tools/builtin/project-management'
import { reminderTools } from './tools/builtin/reminders'
import { routineTools } from './tools/builtin/routines'
import { timerTools } from './tools/builtin/timer'
import { todoTools } from './tools/builtin/todos'
import { weatherTools } from './tools/builtin/weather'
import { widgetsTools } from './tools/builtin/widgets'
import { windowControlTools } from './tools/builtin/window-control'

type ChatSyncMode = 'inactive' | 'authority' | 'follower'
type ToolsetId = 'widgets' | 'artistry' | 'project-management'

interface AttachmentPayload {
  type: 'image'
  data: string
  mimeType: string
}

interface SessionSnapshotPayload {
  activeSessionId: string
  sessionMessages: Record<string, ChatHistoryItem[]>
  sessionMetas: Record<string, ChatSessionMeta>
}

interface StreamSnapshotPayload {
  sending: boolean
  streamingMessage: StreamingAssistantMessage
}

interface IngestCommandPayload {
  text: string
  attachments?: AttachmentPayload[]
  input?: WebSocketEventInputs
  sessionId?: string
  toolset?: ToolsetId
}

interface RetryCommandPayload {
  sessionId?: string
  index: number
}

interface IngestAcceptanceSnapshot {
  sessionId: string
  messageStartIndex: number
  text: string
  hasAttachments: boolean
}

type ChatSyncMessage
  = | { type: 'authority-announcement', authorityId: string, sentAt: number }
    | { type: 'request-snapshot', requestId: string, senderId: string }
    | { type: 'session-snapshot', authorityId: string, snapshot: SessionSnapshotPayload }
    | { type: 'stream-snapshot', authorityId: string, snapshot: StreamSnapshotPayload }
    | { type: 'command', authorityId?: string, requestId: string, senderId: string, command: 'ingest', payload: IngestCommandPayload }
    | { type: 'command', authorityId?: string, requestId: string, senderId: string, command: 'retry', payload: RetryCommandPayload }
    | { type: 'command', authorityId?: string, requestId: string, senderId: string, command: 'cleanup', payload: { sessionId?: string } }
    | { type: 'command', authorityId?: string, requestId: string, senderId: string, command: 'delete-message', payload: { sessionId?: string, messageId?: string, index?: number } }
    | { type: 'response', requestId: string, authorityId: string, ok: boolean, error?: string, ingestAccepted?: boolean }

interface PendingRequest {
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const CHAT_SYNC_CHANNEL_NAME = 'airi:stage-tamagotchi:chat-sync'
const AUTHORITY_HEARTBEAT_INTERVAL_MS = 1000
const REQUEST_TIMEOUT_MS = 30000
const PROJECT_WORK_ITEM_IDENTIFIER_REGEX = /(?:^|[^A-Z0-9])([A-Z][A-Z0-9]*-\d+)(?=$|[^A-Z0-9])/i
const PROJECT_WORK_ITEM_NOTIFICATION_STATUSES = ['done', 'blocked'] as const

type ProjectWorkItemNotificationStatus = (typeof PROJECT_WORK_ITEM_NOTIFICATION_STATUSES)[number]

export function formatChatCommandFailureMessage(message: string): string {
  const trimmed = message.trim()
  return trimmed
    ? `요청을 처리하지 못했어.\n원인: ${trimmed}`
    : '요청을 처리하지 못했어.'
}

/**
 * Checks whether a project work item status should create a chat notification.
 *
 * Use when:
 * - Project-management status events should be surfaced in chat
 * - Non-terminal runner state changes should stay quiet
 *
 * Expects:
 * - `status` is already validated by the project-management schema
 *
 * Returns:
 * - True for terminal user-visible states that need attention
 */
export function isProjectWorkItemNotificationStatus(status: WorkItemStatus): status is ProjectWorkItemNotificationStatus {
  return PROJECT_WORK_ITEM_NOTIFICATION_STATUSES.includes(status as ProjectWorkItemNotificationStatus)
}

/**
 * Formats a project work item status notification for chat.
 *
 * Use when:
 * - A work item has just moved to done or blocked
 * - AIRI should notify the active chat session without asking the model
 *
 * Expects:
 * - `previousStatus` is the status before the persisted update
 * - `workItem.status` is the newly persisted status
 *
 * Returns:
 * - A chat-ready Korean message, or null when no notification is needed
 */
export function formatProjectWorkItemStatusNotification(input: {
  workItem: Pick<WorkItem, 'identifier' | 'status' | 'title'>
  previousStatus: WorkItemStatus
}): string | null {
  if (input.previousStatus === input.workItem.status)
    return null

  if (!isProjectWorkItemNotificationStatus(input.workItem.status))
    return null

  if (input.workItem.status === 'done') {
    return [
      `${input.workItem.identifier} 일감이 완료됐어.`,
      `제목: ${input.workItem.title}`,
      '상태를 done으로 바꿔뒀어. 필요하면 프로젝트 보드에서 변경사항과 실행 메모를 확인해줘.',
    ].join('\n')
  }

  return [
    `${input.workItem.identifier} 일감이 블락됐어.`,
    `제목: ${input.workItem.title}`,
    '상태를 blocked로 바꿔뒀어. 프로젝트 보드의 최근 메모에서 막힌 원인을 확인해줘.',
  ].join('\n')
}

function createRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function getRetryText(message: ChatHistoryItem | undefined): string | null {
  if (!message || message.role !== 'user')
    return null

  if (typeof message.content === 'string') {
    const text = message.content.trim()
    return text || null
  }

  if (!Array.isArray(message.content))
    return null

  const text = message.content.reduce<string[]>((texts, part) => {
    if (part.type !== 'text')
      return texts

    const value = part.text?.trim()
    if (value)
      texts.push(value)

    return texts
  }, []).join('\n\n')

  return text || null
}

function resolveRetrySourceIndex(messages: ChatHistoryItem[], index: number): number {
  const targetMessage = messages[index]
  if (!targetMessage)
    return -1

  if (targetMessage.role === 'user')
    return index

  if (targetMessage.role === 'assistant' || targetMessage.role === 'error') {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (messages[cursor]?.role === 'user')
        return cursor
    }
  }

  return -1
}

export function isProjectBoardOpenRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized)
    return false

  const includesBoardKeyword = [
    '프로젝트 보드',
    '칸반 보드',
    'project board',
    'kanban board',
  ].some(keyword => normalized.includes(keyword))
  const includesOpenKeyword = [
    '열',
    '띄',
    '보여',
    'open',
    'show',
  ].some(keyword => normalized.includes(keyword))

  return includesBoardKeyword && includesOpenKeyword
}

export function isTodoWorkItemListRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized)
    return false

  const includesTodoKeyword = [
    'todo',
    'to-do',
    '할 일',
    '해야 할',
  ].some(keyword => normalized.includes(keyword))
  const includesWorkItemKeyword = [
    '일감',
    '작업',
    'work item',
    'issue',
    'task',
  ].some(keyword => normalized.includes(keyword))
  const includesListKeyword = [
    '알려',
    '보여',
    '목록',
    '리스트',
    '뭐',
    'list',
    'show',
    'current',
  ].some(keyword => normalized.includes(keyword))

  return includesTodoKeyword && includesWorkItemKeyword && includesListKeyword
}

/**
 * Extracts a project work item identifier from free-form chat text.
 *
 * Before:
 * - "AIRI-12 상태 알려줘"
 *
 * After:
 * - "AIRI-12"
 */
export function extractProjectWorkItemIdentifier(text: string): string | null {
  return PROJECT_WORK_ITEM_IDENTIFIER_REGEX.exec(text.trim())?.[1]?.toUpperCase() ?? null
}

/**
 * Resolves the board status a project progress question is focused on.
 *
 * Use when:
 * - A chat question asks for blocked, review, done, in-progress, or TODO work
 * - The progress summary should emphasize one board column
 *
 * Expects:
 * - The text is the raw user chat message
 *
 * Returns:
 * - A work-item status when one can be inferred, otherwise undefined
 */
export function resolveProjectProgressStatus(text: string): WorkItemStatus | undefined {
  const normalized = text.trim().toLowerCase()

  if (['막힌', '막혀', 'blocked', 'blocker', 'blockers'].some(keyword => normalized.includes(keyword)))
    return 'blocked'
  if (['리뷰', '검토', 'review'].some(keyword => normalized.includes(keyword)))
    return 'in_review'
  if (['완료', '끝난', '끝낸', 'done', 'completed', 'finished'].some(keyword => normalized.includes(keyword)))
    return 'done'
  if (['진행 중', '진행중', '작업 중', '작업중', 'in progress', 'working'].some(keyword => normalized.includes(keyword)))
    return 'in_progress'
  if (['todo', 'to-do', '할 일', '해야 할'].some(keyword => normalized.includes(keyword)))
    return 'todo'

  return undefined
}

/**
 * Detects project progress/status questions without catching start commands.
 *
 * Use when:
 * - Chat text should bypass weak tool-calling models for project status summaries
 * - Specific work item status questions like `AIRI-12 상태 알려줘` need local data
 *
 * Expects:
 * - The text is the raw user chat message
 *
 * Returns:
 * - True only for read-only status/progress requests
 */
export function isProjectProgressRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (!normalized)
    return false

  const hasIdentifier = extractProjectWorkItemIdentifier(normalized) != null
  const includesProjectSubject = [
    '프로젝트',
    '일감',
    '작업',
    'issue',
    'task',
    'work item',
    'project',
  ].some(keyword => normalized.includes(keyword))
  const hasProjectProgressScope = hasIdentifier || includesProjectSubject
  const includesExplicitProgressKeyword = [
    '진행상황',
    '진행 상황',
    '진척',
    '현황',
    '어디까지',
    '몇 퍼센트',
    '몇%',
    '퍼센트',
    'progress',
  ].some(keyword => normalized.includes(keyword))
  const includesStatusKeyword = ['상태', 'status', 'how is', 'how are']
    .some(keyword => normalized.includes(keyword))
  const includesConversationalProgress = /진행.*(?:알려|보여|어때|[됐되중])/.test(normalized)
    || /(?:어떻게|잘).*(?:되고|돼|되어|going)/.test(normalized)

  return includesExplicitProgressKeyword
    || Boolean(hasProjectProgressScope && (
      includesStatusKeyword
      || includesConversationalProgress
      || resolveProjectProgressStatus(normalized)
    ))
}

function hasExplicitProjectWorkItemStartIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return [
    /(?:진행|시작|처리|작업|구현)\s*(?:해(?:\s?줘|주세요|라)?|하자|시켜)/,
    /계속\s*진행/,
    /\b(start|work on|proceed|run|implement)\b/,
  ].some(pattern => pattern.test(normalized))
}

/**
 * Extracts a work item identifier from a direct start request.
 *
 * Before:
 * - "AIRI-12 진행해줘"
 *
 * After:
 * - "AIRI-12"
 */
export function extractProjectWorkItemStartIdentifier(text: string): string | null {
  const normalized = text.trim()
  if (!normalized)
    return null

  const identifier = extractProjectWorkItemIdentifier(normalized)
  if (!identifier)
    return null

  if (isProjectProgressRequest(normalized))
    return null

  return hasExplicitProjectWorkItemStartIntent(normalized) ? identifier : null
}

export const useChatSyncStore = defineStore('stage-tamagotchi:chat-sync', () => {
  const instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const mode = ref<ChatSyncMode>('inactive')
  const authorityId = ref<string | null>(null)

  const chatSession = useChatSessionStore()
  const chatStream = useChatStreamStore()
  const chatOrchestrator = useChatOrchestratorStore()
  const { cleanupMessages } = useChatMaintenanceStore()
  const providersStore = useProvidersStore()
  const consciousnessStore = useConsciousnessStore()
  const { activeProvider, activeModel } = storeToRefs(consciousnessStore)
  const { activeSessionId, sessionMessages, sessionMetas } = storeToRefs(chatSession)
  const { streamingMessage } = storeToRefs(chatStream)
  const { sending } = storeToRefs(chatOrchestrator)

  const pendingRequests = new Map<string, PendingRequest>()
  const stopSyncWatchers: Array<() => void> = []
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let channel: BroadcastChannel | null = null

  function post(message: ChatSyncMessage) {
    channel?.postMessage(message)
  }

  function buildSessionSnapshot(): SessionSnapshotPayload {
    return chatSession.getSnapshot()
  }

  function buildStreamSnapshot(): StreamSnapshotPayload {
    return {
      sending: sending.value,
      streamingMessage: JSON.parse(JSON.stringify(streamingMessage.value)) as StreamingAssistantMessage,
    }
  }

  function broadcastAuthorityAnnouncement() {
    if (mode.value !== 'authority')
      return

    post({
      type: 'authority-announcement',
      authorityId: instanceId,
      sentAt: Date.now(),
    })
  }

  function broadcastSessionSnapshot() {
    if (mode.value !== 'authority')
      return

    post({
      type: 'session-snapshot',
      authorityId: instanceId,
      snapshot: buildSessionSnapshot(),
    })
  }

  function broadcastStreamSnapshot() {
    if (mode.value !== 'authority')
      return

    post({
      type: 'stream-snapshot',
      authorityId: instanceId,
      snapshot: buildStreamSnapshot(),
    })
  }

  function stopWatchers() {
    while (stopSyncWatchers.length > 0) {
      const stop = stopSyncWatchers.pop()
      stop?.()
    }
  }

  function appendAssistantMessage(sessionId: string, content: string) {
    chatSession.appendSessionMessage(sessionId, {
      role: 'assistant',
      content,
      slices: [{ type: 'text', text: content }],
      tool_results: [],
      createdAt: Date.now(),
    })
  }

  function appendProjectWorkItemStatusNotification(payload: { workItem: WorkItem, previousStatus: WorkItemStatus }) {
    const content = formatProjectWorkItemStatusNotification(payload)
    if (!content)
      return

    const sessionId = activeSessionId.value
    if (!sessionId)
      return

    appendAssistantMessage(sessionId, content)
  }

  function registerProjectWorkItemStatusNotificationListener() {
    try {
      const context = getElectronEventaContext()
      const stop = context.on(projectManagementWorkItemStatusChanged, (event) => {
        if (!event.body)
          return

        appendProjectWorkItemStatusNotification(event.body)
      })
      stopSyncWatchers.push(stop)
    }
    catch (error) {
      console.warn('[chat-sync] Failed to subscribe to project work item status notifications:', errorMessageFrom(error) ?? 'unknown error')
    }
  }

  function clearHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
  }

  function registerAuthorityWatchers() {
    registerProjectWorkItemStatusNotificationListener()

    stopSyncWatchers.push(
      watch([activeSessionId, sessionMessages, sessionMetas], () => {
        broadcastSessionSnapshot()
      }, { deep: true, immediate: true }),
      watch([sending, streamingMessage], () => {
        broadcastStreamSnapshot()
      }, { deep: true, immediate: true }),
    )

    broadcastAuthorityAnnouncement()
    clearHeartbeat()
    heartbeatTimer = setInterval(() => {
      broadcastAuthorityAnnouncement()
    }, AUTHORITY_HEARTBEAT_INTERVAL_MS)
  }

  function applySessionSnapshot(snapshot: SessionSnapshotPayload) {
    const localActiveSessionId = activeSessionId.value
    const shouldPreserveLocalActiveSession = mode.value === 'follower'
      && !!localActiveSessionId
      && !!snapshot.sessionMessages[localActiveSessionId]

    chatSession.applyRemoteSnapshot({
      ...snapshot,
      activeSessionId: shouldPreserveLocalActiveSession
        ? localActiveSessionId
        : snapshot.activeSessionId,
    })
  }

  function applyStreamSnapshot(snapshot: StreamSnapshotPayload) {
    chatOrchestrator.sending = snapshot.sending
    chatStream.streamingMessage = snapshot.streamingMessage
  }

  function resolveTools(toolset?: ToolsetId) {
    const toolsetRegistry: Record<string, () => Promise<any[]>> = {
      'widgets': async () => {
        const [w, we, pm, fa, ce, dio, mem, rem, rt, wc, td, calc, tmr, db] = await Promise.all([widgetsTools(), weatherTools(), projectManagementTools(), fileAccessTools(), commandExecTools(), desktopIoTools(), memoryTools(), reminderTools(), routineTools(), windowControlTools(), todoTools(), calculatorTools(), timerTools(), dailyBriefingTools()])
        return [...w, ...we, ...pm, ...fa, ...ce, ...dio, ...mem, ...rem, ...rt, ...wc, ...td, ...calc, ...tmr, ...db]
      },
      'artistry': async () => {
        const [ai, wi, we, pm, fa, ce, dio, mem, rem, rt, wc, td, calc, tmr, db] = await Promise.all([
          imageJournalTools(),
          widgetsTools(),
          weatherTools(),
          projectManagementTools(),
          fileAccessTools(),
          commandExecTools(),
          desktopIoTools(),
          memoryTools(),
          reminderTools(),
          routineTools(),
          windowControlTools(),
          todoTools(),
          calculatorTools(),
          timerTools(),
          dailyBriefingTools(),
        ])
        return [...ai, ...wi, ...we, ...pm, ...fa, ...ce, ...dio, ...mem, ...rem, ...rt, ...wc, ...td, ...calc, ...tmr, ...db]
      },
      'project-management': async () => {
        return projectManagementTools()
      },
    }

    if (toolset && toolsetRegistry[toolset]) {
      return toolsetRegistry[toolset]
    }

    return projectManagementTools
  }

  function createIngestAcceptanceSnapshot(payload: IngestCommandPayload): IngestAcceptanceSnapshot {
    const sessionId = payload.sessionId || chatSession.activeSessionId

    return {
      sessionId,
      messageStartIndex: chatSession.getSessionMessages(sessionId).length,
      text: payload.text.trim(),
      hasAttachments: !!payload.attachments?.length,
    }
  }

  function hasAcceptedIngestPayload(snapshot: IngestAcceptanceSnapshot): boolean {
    return chatSession.getSessionMessages(snapshot.sessionId)
      .slice(snapshot.messageStartIndex)
      .some((message) => {
        if (message.role !== 'user')
          return false

        if (snapshot.hasAttachments && Array.isArray(message.content))
          return true

        return getRetryText(message) === snapshot.text
      })
  }

  async function executeIngest(payload: IngestCommandPayload) {
    const providerId = activeProvider.value
    const modelId = activeModel.value
    if (!providerId || !modelId) {
      throw new Error('No active chat provider or model configured')
    }

    const chatProvider = await providersStore.getProviderInstance<ChatProvider>(providerId)
    if (!chatProvider) {
      throw new Error(`Failed to resolve chat provider "${providerId}"`)
    }

    await chatOrchestrator.ingest(payload.text, {
      model: modelId,
      chatProvider,
      attachments: payload.attachments,
      input: payload.input,
      tools: resolveTools(payload.toolset),
    }, payload.sessionId)
  }

  async function executeRetry(payload: RetryCommandPayload) {
    const sessionId = payload.sessionId || chatSession.activeSessionId
    const currentMessages = chatSession.getSessionMessages(sessionId)
    const sourceIndex = resolveRetrySourceIndex(currentMessages, payload.index)
    if (sourceIndex < 0)
      throw new Error('Retry target has no retriable source message')

    const text = getRetryText(currentMessages[sourceIndex])
    if (!text)
      throw new Error('Retry target has no retriable user message')

    const nextMessages = currentMessages.slice(0, sourceIndex)
    chatSession.setSessionMessages(sessionId, nextMessages)

    await executeIngest({
      text,
      sessionId,
      toolset: 'widgets',
    })
  }

  function executeDeleteMessage(payload: { sessionId?: string, messageId?: string, index?: number }) {
    const sessionId = payload.sessionId || chatSession.activeSessionId
    const nextMessages = chatSession.getSessionMessages(sessionId).filter((message, index) => {
      if (payload.messageId)
        return message.id !== payload.messageId
      if (payload.index !== undefined)
        return index !== payload.index
      return true
    })

    chatSession.setSessionMessages(sessionId, nextMessages)
  }

  function appendIngestErrorMessage(payload: IngestCommandPayload, message: string) {
    const sessionId = payload.sessionId || chatSession.activeSessionId
    const nextMessages = [
      ...chatSession.getSessionMessages(sessionId),
      {
        role: 'error',
        content: formatChatCommandFailureMessage(message),
      } satisfies ChatHistoryItem,
    ]
    chatSession.setSessionMessages(sessionId, nextMessages)
  }

  async function executeLocalProjectBoardRequest(payload: IngestCommandPayload): Promise<boolean> {
    if (!isProjectBoardOpenRequest(payload.text))
      return false

    const sessionId = payload.sessionId || chatSession.activeSessionId
    const result = await executeProjectManagementAction({ action: 'open_board' })
    const content = result.startsWith('Opened project board')
      ? '프로젝트 보드를 별도 브라우저로 열었어.'
      : result

    chatSession.appendSessionMessage(sessionId, {
      role: 'user',
      content: payload.text,
    })
    chatSession.appendSessionMessage(sessionId, {
      role: 'assistant',
      content,
      slices: [{ type: 'text', text: content }],
      tool_results: [],
    })

    return true
  }

  async function executeLocalTodoWorkItemListRequest(payload: IngestCommandPayload): Promise<boolean> {
    if (!isTodoWorkItemListRequest(payload.text))
      return false

    const sessionId = payload.sessionId || chatSession.activeSessionId
    const result = await executeProjectManagementAction({
      action: 'list_work_items',
      status: 'todo',
    })
    const content = result.trim()
      ? `현재 TODO 일감은:\n${result}`
      : '현재 TODO 일감이 없어.'

    chatSession.appendSessionMessage(sessionId, {
      role: 'user',
      content: payload.text,
    })
    chatSession.appendSessionMessage(sessionId, {
      role: 'assistant',
      content,
      slices: [{ type: 'text', text: content }],
      tool_results: [],
    })

    return true
  }

  async function executeLocalProjectProgressRequest(payload: IngestCommandPayload): Promise<boolean> {
    if (!isProjectProgressRequest(payload.text))
      return false

    const sessionId = payload.sessionId || chatSession.activeSessionId
    const content = await executeProjectManagementAction({
      action: 'summarize_progress',
      identifier: extractProjectWorkItemIdentifier(payload.text),
      status: resolveProjectProgressStatus(payload.text),
    })

    chatSession.appendSessionMessage(sessionId, {
      role: 'user',
      content: payload.text,
    })
    chatSession.appendSessionMessage(sessionId, {
      role: 'assistant',
      content,
      slices: [{ type: 'text', text: content }],
      tool_results: [],
    })

    return true
  }

  async function executeLocalProjectWorkItemStartRequest(payload: IngestCommandPayload): Promise<boolean> {
    const identifier = extractProjectWorkItemStartIdentifier(payload.text)
    if (!identifier)
      return false

    const sessionId = payload.sessionId || chatSession.activeSessionId
    const content = await executeProjectManagementAction({
      action: 'start_work_item',
      identifier,
    })

    chatSession.appendSessionMessage(sessionId, {
      role: 'user',
      content: payload.text,
    })
    chatSession.appendSessionMessage(sessionId, {
      role: 'assistant',
      content,
      slices: [{ type: 'text', text: content }],
      tool_results: [],
    })

    return true
  }

  async function handleCommand(message: Extract<ChatSyncMessage, { type: 'command' }>) {
    if (mode.value !== 'authority')
      return

    const respond = (ok: boolean, error?: string, options?: { ingestAccepted?: boolean }) => {
      post({
        type: 'response',
        requestId: message.requestId,
        authorityId: instanceId,
        ok,
        error,
        ...options,
      })
    }

    let ingestAcceptanceSnapshot: IngestAcceptanceSnapshot | undefined
    try {
      switch (message.command) {
        case 'ingest':
          ingestAcceptanceSnapshot = createIngestAcceptanceSnapshot(message.payload)
          if (
            !await executeLocalTodoWorkItemListRequest(message.payload)
            && !await executeLocalProjectProgressRequest(message.payload)
            && !await executeLocalProjectWorkItemStartRequest(message.payload)
            && !await executeLocalProjectBoardRequest(message.payload)
          ) {
            await executeIngest(message.payload)
          }
          break
        case 'retry':
          await executeRetry(message.payload)
          break
        case 'cleanup':
          cleanupMessages(message.payload.sessionId)
          break
        case 'delete-message':
          executeDeleteMessage(message.payload)
          break
      }

      respond(true)
    }
    catch (error) {
      const errorMessage = errorMessageFrom(error) ?? 'Unknown chat sync command failure'
      const ingestAccepted = message.command === 'ingest'
        && ingestAcceptanceSnapshot != null
        && hasAcceptedIngestPayload(ingestAcceptanceSnapshot)

      if (message.command === 'ingest')
        appendIngestErrorMessage(message.payload, errorMessage)

      respond(false, errorMessage, ingestAccepted ? { ingestAccepted } : undefined)
    }
  }

  function handleResponse(message: Extract<ChatSyncMessage, { type: 'response' }>) {
    const pending = pendingRequests.get(message.requestId)
    if (!pending)
      return

    clearTimeout(pending.timeout)
    pendingRequests.delete(message.requestId)

    if (message.ok || message.ingestAccepted) {
      pending.resolve()
      return
    }

    pending.reject(new Error(message.error ?? 'Remote chat command failed'))
  }

  function handleMessage(event: MessageEvent<ChatSyncMessage>) {
    const message = event.data
    if (!message)
      return

    switch (message.type) {
      case 'authority-announcement':
        authorityId.value = message.authorityId
        if (mode.value === 'follower')
          post({ type: 'request-snapshot', requestId: createRequestId(), senderId: instanceId })
        return
      case 'request-snapshot':
        if (mode.value === 'authority')
          broadcastSessionSnapshot()
        return
      case 'session-snapshot':
        if (mode.value !== 'follower')
          return
        authorityId.value = message.authorityId
        applySessionSnapshot(message.snapshot)
        return
      case 'stream-snapshot':
        if (mode.value !== 'follower')
          return
        authorityId.value = message.authorityId
        applyStreamSnapshot(message.snapshot)
        return
      case 'command':
        void handleCommand(message)
        return
      case 'response':
        handleResponse(message)
    }
  }

  function attachChannel() {
    if (channel)
      return

    channel = new BroadcastChannel(CHAT_SYNC_CHANNEL_NAME)
    channel.addEventListener('message', handleMessage as EventListener)
  }

  function detachChannel() {
    if (!channel)
      return

    channel.removeEventListener('message', handleMessage as EventListener)
    channel.close()
    channel = null
  }

  function resetPendingRequests() {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Chat sync channel disposed'))
    }
    pendingRequests.clear()
  }

  function initialize(nextMode: Exclude<ChatSyncMode, 'inactive'>) {
    if (mode.value === nextMode && channel)
      return

    dispose()
    attachChannel()
    mode.value = nextMode
    authorityId.value = nextMode === 'authority' ? instanceId : authorityId.value

    if (nextMode === 'authority') {
      registerAuthorityWatchers()
      broadcastSessionSnapshot()
      broadcastStreamSnapshot()
      return
    }

    post({ type: 'request-snapshot', requestId: createRequestId(), senderId: instanceId })
  }

  function dispatchCommand(message: Extract<ChatSyncMessage, { type: 'command' }>) {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(message.requestId)
        reject(new Error('Timed out waiting for chat authority response'))
      }, REQUEST_TIMEOUT_MS)

      pendingRequests.set(message.requestId, { resolve, reject, timeout })
      post(message)
    })
  }

  async function requestIngest(payload: IngestCommandPayload) {
    if (mode.value === 'authority') {
      const ingestAcceptanceSnapshot = createIngestAcceptanceSnapshot(payload)

      try {
        if (await executeLocalTodoWorkItemListRequest(payload))
          return

        if (await executeLocalProjectProgressRequest(payload))
          return

        if (await executeLocalProjectWorkItemStartRequest(payload))
          return

        if (await executeLocalProjectBoardRequest(payload))
          return

        await executeIngest(payload)
      }
      catch (error) {
        if (hasAcceptedIngestPayload(ingestAcceptanceSnapshot)) {
          appendIngestErrorMessage(payload, errorMessageFrom(error) ?? 'Unknown chat sync command failure')
          return
        }

        throw error
      }
      return
    }

    return await dispatchCommand({
      type: 'command',
      requestId: createRequestId(),
      senderId: instanceId,
      command: 'ingest',
      payload,
    })
  }

  async function requestRetry(payload: RetryCommandPayload) {
    if (mode.value === 'authority') {
      await executeRetry(payload)
      return
    }

    return await dispatchCommand({
      type: 'command',
      requestId: createRequestId(),
      senderId: instanceId,
      command: 'retry',
      payload,
    })
  }

  async function requestCleanup(sessionId?: string) {
    if (mode.value === 'authority') {
      cleanupMessages(sessionId)
      return
    }

    return await dispatchCommand({
      type: 'command',
      requestId: createRequestId(),
      senderId: instanceId,
      command: 'cleanup',
      payload: { sessionId },
    })
  }

  async function requestDeleteMessage(payload: { sessionId?: string, messageId?: string, index?: number }) {
    if (mode.value === 'authority') {
      executeDeleteMessage(payload)
      return
    }

    return await dispatchCommand({
      type: 'command',
      requestId: createRequestId(),
      senderId: instanceId,
      command: 'delete-message',
      payload,
    })
  }

  function dispose() {
    stopWatchers()
    clearHeartbeat()
    resetPendingRequests()
    detachChannel()
    mode.value = 'inactive'
    authorityId.value = null
  }

  return {
    authorityId,
    mode,
    initialize,
    dispose,
    requestIngest,
    requestRetry,
    requestCleanup,
    requestDeleteMessage,
  }
})
