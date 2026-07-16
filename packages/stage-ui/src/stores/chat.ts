import type { WebSocketEventInputs } from '@proj-airi/server-sdk'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { CommonContentPart, Message, ToolMessage } from '@xsai/shared-chat'

import type { ChatAssistantMessage, ChatSlices, ChatStreamEventContext, StreamingAssistantMessage } from '../types/chat'
import type { StreamEvent, StreamOptions } from './llm'

import { errorMessageFrom } from '@moeru/std'
import { IOAttributes, IOEvents, IOSpanNames, IOSubsystems } from '@proj-airi/stage-shared'
import { createQueue } from '@proj-airi/stream-kit'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { computed, ref, toRaw } from 'vue'

import { useAnalytics } from '../composables'
import { useLlmmarkerParser } from '../composables/llm-marker-parser'
import { categorizeResponse, createStreamingCategorizer } from '../composables/response-categoriser'
import { activeTurnSpan, startSpan } from '../composables/use-io-tracer'
import { cloneDeepSafe } from '../utils/clone'
import { formatContextPromptText } from './chat/context-prompt'
import { createMinecraftContext } from './chat/context-providers'
import { useChatContextStore } from './chat/context-store'
import { formatTimePrefix } from './chat/datetime-prefix'
import { applyHistoryWindow } from './chat/history-window'
import { createChatHooks } from './chat/hooks'
import { useChatSessionStore } from './chat/session-store'
import { useChatStreamStore } from './chat/stream-store'
import { useContextObservabilityStore } from './devtools/context-observability'
import { useLLM } from './llm'
import { useAiriCardStore } from './modules/airi-card'
import { useAutonomousArtistryStore } from './modules/artistry-autonomous'
import { useConsciousnessStore } from './modules/consciousness'

// Prepends a literal text fragment to a message's content. Handles both the
// shorthand string form and the array-of-parts form. When the first part is
// already text, it merges into that part to keep the part count stable for
// downstream consumers; otherwise it inserts a new text part at the front.
// Constraint is `content?: unknown` to admit both required-content roles
// (system/user) and optional-content roles (assistant); the generic preserves
// the caller's discriminated-union narrowing.
function prependTextToContent<T extends { content?: unknown }>(msg: T, text: string): T {
  const content = msg.content
  if (content === undefined)
    return { ...msg, content: text } as T
  if (typeof content === 'string')
    return { ...msg, content: `${text}${content}` } as T

  if (Array.isArray(content)) {
    const first = content[0] as { type?: string, text?: string } | undefined
    if (first && first.type === 'text' && typeof first.text === 'string') {
      const next = [{ ...first, text: `${text}${first.text}` }, ...content.slice(1)]
      return { ...msg, content: next } as T
    }
    return { ...msg, content: [{ type: 'text', text }, ...content] } as T
  }

  return msg
}

// NOTICE: previously an inline structuredClone-with-JSON-fallback helper
// (cloneStreamingMessage); replaced by the shared reactivity-safe clone util.

function formatToolFailureNotice(error: unknown): string {
  const message = errorMessageFrom(error) ?? (typeof error === 'string' ? error : JSON.stringify(error))
  return message
    ? `도구 실행에 실패했어. 요청을 처리하지 못했어.\n원인: ${message}`
    : '도구 실행에 실패했어. 요청을 처리하지 못했어.'
}

interface SendOptions {
  model: string
  chatProvider: ChatProvider
  providerConfig?: Record<string, unknown>
  attachments?: { type: 'image', data: string, mimeType: string }[]
  tools?: StreamOptions['tools']
  input?: WebSocketEventInputs
}

interface ForkOptions {
  fromSessionId?: string
  atIndex?: number
  reason?: string
  hidden?: boolean
}

interface QueuedSend {
  sendingMessage: string
  options: SendOptions
  generation: number
  sessionId: string
  cancelled?: boolean
  deferred: {
    resolve: () => void
    reject: (error: unknown) => void
  }
}

export interface QueuedSendSnapshot {
  sessionId: string
  generation: number
  cancelled: boolean
  messagePreview: string
  hasAttachments: boolean
  inputType?: WebSocketEventInputs['type']
}

export const useChatOrchestratorStore = defineStore('chat-orchestrator', () => {
  const llmStore = useLLM()
  const consciousnessStore = useConsciousnessStore()
  const artistryAutonomousStore = useAutonomousArtistryStore()
  const { activeProvider } = storeToRefs(consciousnessStore)
  const { trackFirstMessage } = useAnalytics()

  const chatSession = useChatSessionStore()
  const chatStream = useChatStreamStore()
  const chatContext = useChatContextStore()
  const cardStore = useAiriCardStore()
  const contextObservability = useContextObservabilityStore()
  const { activeSessionId } = storeToRefs(chatSession)
  const { streamingMessage } = storeToRefs(chatStream)

  const sending = ref(false)
  const pendingQueuedSends = ref<QueuedSend[]>([])
  const pendingQueuedSendCount = computed(() => pendingQueuedSends.value.length)
  const hooks = createChatHooks()

  /**
   * Max time one chat turn may make *no progress* before it is force-recovered.
   * A turn normally ends when the LLM stream and its post-stream hooks finish;
   * if something downstream hangs (a hook awaiting a dead service, a renderer
   * freeze), performSend never returns, the send queue worker stays blocked, and
   * the UI is stuck "thinking" forever with no recovery. The watchdog frees it.
   *
   * NOTICE: re-armed on every progress signal (phase transition and stream
   * event -- see setTurnPhase / bumpStreamIdle), so it measures silence since
   * the last sign of life, not total turn wall-time. Without this, a local
   * reasoning model (e.g. Qwen3 *-A3B on LM Studio) that legitimately streams
   * reasoning tokens for minutes would be aborted mid-answer even though it
   * never actually hung. The `streaming`-phase silence case is still caught far
   * sooner by STREAM_IDLE_TIMEOUT_MS. Set generously (5 min) because a single
   * post-stream hook awaiting a slow local service can legitimately take a
   * while; it only needs to be short enough that a truly wedged turn recovers
   * before the user gives up.
   */
  const TURN_WATCHDOG_MS = 300_000

  /**
   * Max silence allowed mid-stream before the LLM call is aborted. The overall
   * turn watchdog only recovers after TURN_WATCHDOG_MS; this catches the common
   * `streaming`-phase hang far sooner — LM Studio / llama.cpp sometimes stops
   * emitting tokens without closing the SSE stream (stalled generation, a
   * tool-grammar hiccup), so xsai's reader awaits forever. Resetting on every
   * stream event means a legitimately slow model never trips it; only true
   * silence does. Aborting surfaces a fast, retriable error and keeps any
   * partial reply that already arrived.
   *
   * NOTICE: set to 2 min rather than a tighter value because the first token
   * on a local backend can lag far behind the request: LM Studio / llama.cpp
   * may load the model on the first call (cold start) and must prefill a large
   * prompt before emitting anything, and both happen with zero stream events.
   * A tighter window would abort a healthy cold start before its first token.
   */
  const STREAM_IDLE_TIMEOUT_MS = 120_000

  /**
   * Coarse label of what the current turn is doing, updated as performSend
   * progresses. The watchdog logs this so a hang is attributed to a concrete
   * phase (e.g. "hooks:responseEnd") instead of a vague "stuck".
   */
  let currentTurnPhase = 'idle'

  // Set by the active send's queue handler so progress signals (phase changes,
  // stream events) can re-arm the turn watchdog. Undefined while no send is in
  // flight; a no-op call is harmless.
  let bumpTurnWatchdog: (() => void) | undefined

  // Records the current turn phase and traces the transition, so a stall is
  // visible in the console immediately (the last phase logged is where it hung)
  // without waiting for the watchdog to fire. A transition is progress, so it
  // also re-arms the turn watchdog.
  function setTurnPhase(phase: string) {
    currentTurnPhase = phase
    bumpTurnWatchdog?.()
    console.info(`[chat] turn phase: ${phase}`)
  }

  const sendQueue = createQueue<QueuedSend>({
    handlers: [
      async ({ data }) => {
        const { sendingMessage, options, generation, deferred, sessionId, cancelled } = data

        if (cancelled)
          return

        if (chatSession.getSessionGeneration(sessionId) !== generation) {
          deferred.reject(new Error('Chat session was reset before send could start'))
          return
        }

        // Race the turn against a watchdog so a hung downstream step (a
        // post-stream hook awaiting a dead service, a frozen renderer) cannot
        // block the queue worker and leave the UI stuck "thinking" forever.
        // The phase is captured at FIRE time (not creation) and embedded in
        // both the thrown error and the user-facing message, so the stuck phase
        // is visible without digging through the renderer console.
        let watchdogFired = false
        let watchdogPhase = ''
        let watchdogTimer: ReturnType<typeof setTimeout> | undefined
        // Re-armable: any progress signal restarts the timer, so the watchdog
        // measures silence-since-last-progress rather than total turn time. A
        // continuously streaming model never trips it; only a phase that makes
        // no progress for TURN_WATCHDOG_MS does.
        const armWatchdog = (reject: (error: Error) => void) => {
          if (watchdogTimer) {
            clearTimeout(watchdogTimer)
          }
          watchdogTimer = setTimeout(() => {
            watchdogFired = true
            watchdogPhase = currentTurnPhase
            reject(new Error(`chat turn watchdog timeout: stuck in phase "${watchdogPhase}"`))
          }, TURN_WATCHDOG_MS)
        }
        const watchdog = new Promise<never>((_, reject) => {
          bumpTurnWatchdog = () => armWatchdog(reject)
          armWatchdog(reject)
        })

        try {
          await Promise.race([performSend(sendingMessage, options, generation, sessionId), watchdog])
          deferred.resolve()
        }
        catch (error) {
          if (watchdogFired) {
            // Recover: neutralize the orphaned turn (its remaining
            // generation-guarded steps no-op), unstick the UI, and tell the
            // user. The orphaned performSend keeps running but is now stale.
            console.error(`[chat] turn watchdog fired in phase "${watchdogPhase}"; recovering. The turn did not finish within ${TURN_WATCHDOG_MS}ms.`)
            chatSession.bumpSessionGeneration(sessionId)
            sending.value = false
            chatSession.appendSessionMessage(sessionId, {
              role: 'error',
              content: `응답이 시간 내에 끝나지 않아 중단했어 (멈춘 단계: ${watchdogPhase}). 다시 시도해줘.`,
              createdAt: Date.now(),
              id: nanoid(),
            })
          }
          deferred.reject(error)
        }
        finally {
          bumpTurnWatchdog = undefined
          if (watchdogTimer) {
            clearTimeout(watchdogTimer)
          }
        }
      },
    ],
  })

  sendQueue.on('enqueue', (queuedSend) => {
    pendingQueuedSends.value.push(queuedSend)
  })

  sendQueue.on('dequeue', (queuedSend) => {
    pendingQueuedSends.value = pendingQueuedSends.value.filter(item => item !== queuedSend)
  })

  async function performSend(
    sendingMessage: string,
    options: SendOptions,
    generation: number,
    sessionId: string,
  ) {
    if (!sendingMessage && !options.attachments?.length)
      return

    chatSession.ensureSession(sessionId)

    // Datetime is no longer injected through the side-channel context store.
    // It is applied at message-assembly time (see below) as a system-prompt
    // date anchor + per-message [HH:MM] prefixes, which is more KV-cache
    // friendly and less prone to weak models echoing timestamps verbatim.
    const minecraftContext = createMinecraftContext()
    if (minecraftContext)
      chatContext.ingestContextMessage(minecraftContext)

    const sendingCreatedAt = Date.now()
    // TODO: Expire or prune stale runtime contexts from disconnected services before composing.
    // The Minecraft page already times out service liveness locally, but the shared chat context
    // snapshot can still retain the last runtime context:update until we add cross-store expiry.
    const streamingMessageContext: ChatStreamEventContext = {
      message: { role: 'user', content: sendingMessage, createdAt: sendingCreatedAt, id: nanoid() },
      contexts: chatContext.getContextsSnapshot(),
      composedMessage: [],
      input: options.input,
    }
    contextObservability.recordLifecycle({
      phase: 'before-compose',
      channel: 'chat',
      sessionId,
      textPreview: sendingMessage,
      details: {
        contexts: streamingMessageContext.contexts,
      },
    })

    const isStaleGeneration = () => chatSession.getSessionGeneration(sessionId) !== generation
    const shouldAbort = () => isStaleGeneration()
    if (shouldAbort())
      return

    sending.value = true
    let hadExistingTurn = false

    const isForegroundSession = () => sessionId === activeSessionId.value

    const buildingMessage: StreamingAssistantMessage = { role: 'assistant', content: '', slices: [], tool_results: [], createdAt: Date.now(), id: nanoid() }

    const updateUI = () => {
      if (isForegroundSession()) {
        streamingMessage.value = cloneDeepSafe(buildingMessage)
      }
    }

    updateUI()
    trackFirstMessage()

    try {
      await hooks.emitBeforeMessageComposedHooks(sendingMessage, streamingMessageContext)

      const contentParts: CommonContentPart[] = [{ type: 'text', text: sendingMessage }]

      if (options.attachments) {
        for (const attachment of options.attachments) {
          if (attachment.type === 'image') {
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${attachment.mimeType};base64,${attachment.data}`,
              },
            })
          }
        }
      }

      const finalContent = contentParts.length > 1 ? contentParts : sendingMessage
      if (!streamingMessageContext.input) {
        streamingMessageContext.input = {
          type: 'input:text',
          data: {
            text: sendingMessage,
          },
        }
      }

      if (shouldAbort())
        return

      chatSession.appendSessionMessage(sessionId, {
        role: 'user',
        content: finalContent,
        createdAt: sendingCreatedAt,
        id: nanoid(),
      })
      const sessionMessagesForSend = chatSession.getSessionMessages(sessionId)

      // --------------------------------
      // Cinematic Autonomy (Autonomous Artist)
      // Trigger now only if in user-centric mode. Assistant-centric runs after response is complete.
      const autonomousTarget = cardStore.activeCard?.extensions?.airi?.modules?.artistry?.autonomousTarget || 'user'
      if (autonomousTarget === 'user') {
        void artistryAutonomousStore.runArtistTask(sendingMessage, sessionMessagesForSend as any)
      }
      // --------------------------------

      const categorizer = createStreamingCategorizer(activeProvider.value)
      let streamPosition = 0

      // Reasoning emitted natively by the model (xsai `reasoning-delta`
      // events from `delta.reasoning` / `delta.reasoning_content`). Kept
      // separate from `fullText`: it is shown in the collapsible reasoning
      // section but never spoken, persisted as content, or sent back to the
      // LLM as part of the reply.
      let nativeReasoning = ''
      let reasoningCharsSinceUiFlush = 0

      const parser = useLlmmarkerParser({
        onLiteral: async (literal) => {
          if (shouldAbort())
            return

          categorizer.consume(literal)

          const speechOnly = categorizer.filterToSpeech(literal, streamPosition)
          streamPosition += literal.length

          if (speechOnly.trim()) {
            buildingMessage.content += speechOnly

            await hooks.emitTokenLiteralHooks(speechOnly, streamingMessageContext)

            const lastSlice = buildingMessage.slices.at(-1)
            if (lastSlice?.type === 'text') {
              lastSlice.text += speechOnly
            }
            else {
              buildingMessage.slices.push({
                type: 'text',
                text: speechOnly,
              })
            }
            updateUI()
          }
        },
        onSpecial: async (special) => {
          if (shouldAbort())
            return

          await hooks.emitTokenSpecialHooks(special, streamingMessageContext)
        },
        onEnd: async (fullText) => {
          if (isStaleGeneration())
            return

          const finalCategorization = categorizeResponse(fullText, activeProvider.value)

          buildingMessage.categorization = {
            speech: finalCategorization.speech,
            // Tag-based reasoning (<think> blocks inside the text) wins when
            // present; otherwise keep the natively streamed reasoning so it
            // is not wiped at finalization.
            reasoning: finalCategorization.reasoning || nativeReasoning,
          }
          updateUI()
        },
        minLiteralEmitLength: 24,
      })

      const toolCallQueue = createQueue<ChatSlices>({
        handlers: [
          async (ctx) => {
            if (shouldAbort())
              return
            if (ctx.data.type === 'tool-call') {
              buildingMessage.slices.push(ctx.data)
              updateUI()
              return
            }

            if (ctx.data.type === 'tool-call-result') {
              buildingMessage.tool_results.push(ctx.data)
              updateUI()
            }
          },
        ],
      })

      // Per-message datetime injection (replaces the old `<context>` XML block):
      // every user/assistant message gets a `[YYYY-MM-DD HH:MM]` prefix
      // derived from its persisted `createdAt`. The full date appears on every
      // turn so the model can read "today" from the most recent message; the
      // system prompt itself stays 100% static for permanent KV-cache reuse.
      // Legacy entries without a persisted `createdAt` fall back to "now"
      // rather than a fabricated older timestamp.
      // See `./chat/datetime-prefix.ts` for the rationale.
      const nowTs = Date.now()

      // Bound the prompt size before composing: the full session history stays
      // intact in the session store (and in the UI); only the per-turn view
      // sent to the LLM is windowed. See `./chat/history-window.ts` for the
      // KV-cache-friendly hysteresis rationale.
      const historyWindow = applyHistoryWindow(sessionMessagesForSend)
      if (historyWindow.droppedCount > 0) {
        contextObservability.recordLifecycle({
          phase: 'before-compose',
          channel: 'chat',
          sessionId,
          textPreview: `history window dropped ${historyWindow.droppedCount} oldest message(s)`,
        })
      }

      const newMessages = historyWindow.messages.map((msg) => {
        // toRaw BEFORE destructuring: session history is deep-reactive, so
        // rest-spreading the proxy itself yields a plain object whose nested
        // values (e.g. an image attachment's `content` parts array) are still
        // reactive Proxies, and structuredClone rejects Proxies downstream
        // (context-bridge stream hooks) with DataCloneError "# could not be
        // cloned". Destructuring from the raw target keeps the composed
        // message plain all the way down.
        const { context: _context, id: _id, createdAt, ...rawMessage } = toRaw(msg)
        const ts = createdAt ?? nowTs

        if (rawMessage.role === 'user') {
          return prependTextToContent(rawMessage, formatTimePrefix(ts))
        }

        if (rawMessage.role === 'assistant') {
          const { slices: _slices, tool_results: _toolResults, categorization: _categorization, ...rest } = rawMessage as ChatAssistantMessage
          return prependTextToContent(rest, formatTimePrefix(ts))
        }

        return rawMessage
      })

      const contextsSnapshot = chatContext.getContextsSnapshot()
      const contextPromptText = formatContextPromptText(contextsSnapshot)
      if (contextPromptText) {
        // Merge context into the latest user message instead of inserting a
        // separate user message, which would create consecutive same-role
        // messages forbidden by some providers (e.g. Anthropic → 400 error).
        // Appending at the end keeps the static history prefix stable for
        // LLM KV-cache reuse.
        // See: https://github.com/moeru-ai/airi/issues/1539
        const lastMessage = newMessages.at(-1)
        if (lastMessage && lastMessage.role === 'user') {
          // Append context after the user's content, separated by a newline.
          // Keeping it at the end of the last message preserves the static
          // history prefix for LLM KV-cache reuse.
          const existingParts = typeof lastMessage.content === 'string'
            ? [{ type: 'text' as const, text: lastMessage.content }]
            : lastMessage.content

          lastMessage.content = [
            ...existingParts,
            { type: 'text' as const, text: `\n${contextPromptText}` },
          ]
        }

        contextObservability.recordLifecycle({
          phase: 'prompt-context-built',
          channel: 'chat',
          sessionId,
          details: {
            contexts: contextsSnapshot,
            promptText: contextPromptText,
          },
        })
      }

      streamingMessageContext.composedMessage = newMessages as Message[]
      contextObservability.capturePromptProjection({
        sessionId,
        message: sendingMessage,
        contexts: contextsSnapshot,
        promptMessage: undefined,
        composedMessage: newMessages as Message[],
      })
      contextObservability.recordLifecycle({
        phase: 'after-compose',
        channel: 'chat',
        sessionId,
        textPreview: sendingMessage,
        details: {
          composedMessage: newMessages,
        },
      })

      await hooks.emitAfterMessageComposedHooks(sendingMessage, streamingMessageContext)
      await hooks.emitBeforeSendHooks(sendingMessage, streamingMessageContext)

      let fullText = ''
      const headers = (options.providerConfig?.headers || {}) as Record<string, string>

      if (shouldAbort())
        return

      hadExistingTurn = !!activeTurnSpan.value
      if (!hadExistingTurn)
        activeTurnSpan.value = startSpan(IOSpanNames.InteractionTurn)

      const llmSpan = startSpan(IOSpanNames.LLMInference, activeTurnSpan.value, {
        [IOAttributes.Subsystem]: IOSubsystems.LLM,
        [IOAttributes.GenAIRequestModel]: options.model,
      })
      const llmRequestTs = performance.now()
      let llmFirstTokenEmitted = false

      setTurnPhase('streaming')
      // Stream idle-abort: if the model goes silent mid-stream (no event for
      // STREAM_IDLE_TIMEOUT_MS) the SSE read would otherwise hang until the
      // turn watchdog. Abort the underlying request so the turn ends fast and
      // keeps whatever partial reply already arrived.
      const streamAbort = new AbortController()
      let streamIdleAborted = false
      let streamIdleTimer: ReturnType<typeof setTimeout> | undefined
      // Pauses the idle timer between the tool-call and tool-result events so a
      // brief legitimate silence there does not trip it.
      // NOTICE: xsai emits both events back-to-back AFTER executeTool already
      // resolved, so this window is near-instant and does NOT cover the real
      // tool-execution hang -- that is handled by the streamGaveUp race above.
      let pendingToolCalls = 0
      // Resolved when the idle timer gives up on the stream. We race the stream
      // against this so the turn proceeds even if the underlying stream promise
      // never settles.
      //
      // NOTICE:
      // xsai runs tool execute() BETWEEN stream steps and only emits the
      // tool-call / tool-result events AFTER it resolves (see node_modules
      // @xsai/stream-text dist/index.js:138 `await Promise.all(... executeTool
      // ...)` then :154 pushEvent). So while a tool is executing there are zero
      // stream events, and a tool whose execute() ignores the abort signal
      // (e.g. an MCP/eventa RPC awaiting a dead runtime) is NOT interrupted by
      // streamAbort.abort() -- the stream promise stays pending and the turn
      // would otherwise hang until the coarse turn watchdog (observed as a
      // ~5min "stuck in phase streaming" with local models). Resolving this
      // give-up lets us end the turn at STREAM_IDLE_TIMEOUT_MS, keeping the
      // partial reply, regardless of whether abort is honored downstream.
      // Removal condition: once xsai surfaces per-tool execution timeouts / the
      // abort signal reliably rejects executeTool for all provider tools.
      let resolveStreamGaveUp: (() => void) | undefined
      const streamGaveUp = new Promise<void>((resolve) => {
        resolveStreamGaveUp = resolve
      })
      const bumpStreamIdle = () => {
        // Any stream event is turn progress; keep the overall turn watchdog
        // alive too so a long-but-healthy generation is not falsely timed out.
        bumpTurnWatchdog?.()
        if (streamIdleTimer)
          clearTimeout(streamIdleTimer)
        if (pendingToolCalls > 0)
          return
        streamIdleTimer = setTimeout(() => {
          streamIdleAborted = true
          streamAbort.abort()
          // Unblock the turn even if abort is not honored downstream (a hung
          // tool execute()); the abandoned stream promise is caught below.
          resolveStreamGaveUp?.()
        }, STREAM_IDLE_TIMEOUT_MS)
      }
      bumpStreamIdle()
      // Kept as a handle so the idle give-up race can abandon it. A separate
      // no-op catch prevents an unhandled rejection if the abandoned call
      // rejects later (the awaited race below still observes real errors).
      const streamPromise = llmStore.stream(options.model, options.chatProvider, newMessages as Message[], {
        headers,
        tools: options.tools,
        abortSignal: streamAbort.signal,
        // NOTICE: xsai stream may emit `finish` before tool steps continue, so keep waiting until
        // the final non-tool finish to avoid ending the chat turn with no assistant reply.
        waitForTools: true,
        onStreamEvent: async (event: StreamEvent) => {
          // Once we have given up on this stream (idle-abort fired), ignore
          // any late events from the abandoned call so they cannot re-arm the
          // idle timer or mutate the UI for an already-finished turn.
          if (streamIdleAborted)
            return
            // Track in-flight tool calls so the idle timer pauses during tool
            // execution, then reset it: any event means the model is alive.
          if (event.type === 'tool-call')
            pendingToolCalls += 1
          else if (event.type === 'tool-result' || event.type === 'tool-error')
            pendingToolCalls = Math.max(0, pendingToolCalls - 1)
          bumpStreamIdle()
          switch (event.type) {
            case 'tool-call':
              toolCallQueue.enqueue({
                type: 'tool-call',
                toolCall: event,
              })

              break
            case 'tool-result':
              toolCallQueue.enqueue({
                type: 'tool-call-result',
                id: event.toolCallId,
                result: event.result,
              })

              break
            case 'tool-error':
              toolCallQueue.enqueue({
                type: 'tool-call-result',
                id: event.toolCallId,
                isError: true,
                result: event.result,
              })
              {
                const notice = formatToolFailureNotice(event.result)
                fullText += notice
                buildingMessage.content += notice
                buildingMessage.slices.push({
                  type: 'text',
                  text: notice,
                })
                updateUI()
              }

              break
            case 'reasoning-delta':
              // Reasoning counts as the model's first output for TTFT:
              // reasoning models can think for tens of seconds before the
              // first content token, and the turn is not "silent" anymore.
              if (!llmFirstTokenEmitted) {
                llmFirstTokenEmitted = true
                llmSpan.addEvent(IOEvents.LLMFirstToken, {
                  [IOAttributes.LLM_TTFT]: performance.now() - llmRequestTs,
                })
              }
              nativeReasoning += event.text
              reasoningCharsSinceUiFlush += event.text.length
              buildingMessage.categorization = {
                speech: buildingMessage.categorization?.speech ?? '',
                reasoning: nativeReasoning,
              }
              // Reasoning chunks arrive per-token; cloning the streaming
              // message every chunk is wasteful, so flush in ~48-char steps.
              if (reasoningCharsSinceUiFlush >= 48) {
                reasoningCharsSinceUiFlush = 0
                updateUI()
              }
              break
            case 'text-delta':
              if (!llmFirstTokenEmitted) {
                llmFirstTokenEmitted = true
                llmSpan.addEvent(IOEvents.LLMFirstToken, {
                  [IOAttributes.LLM_TTFT]: performance.now() - llmRequestTs,
                })
              }
              fullText += event.text
              await parser.consume(event.text)
              break
            case 'finish':
              break
            case 'error':
              throw event.error ?? new Error('Stream error')
          }
        },
      })

      // Prevent an unhandled rejection if the idle give-up race abandons this
      // promise and the hung call rejects only later; the awaited race below
      // still observes real errors on the not-abandoned path.
      void streamPromise.catch(() => {})

      try {
        // Race the stream against the idle give-up so a stream promise that
        // never settles (hung tool execute() ignoring abort) cannot hold the
        // turn until the coarse turn watchdog. Winning via streamGaveUp leaves
        // the abandoned stream running, but its late events are ignored (see
        // the streamIdleAborted guard in onStreamEvent).
        await Promise.race([streamPromise, streamGaveUp])
        llmSpan.setAttribute(IOAttributes.LLMTextLength, fullText.length)
      }
      catch (error) {
        // Rethrow anything that is not our own idle-abort; the idle path keeps
        // the partial reply, handled once after the finally below.
        if (!streamIdleAborted)
          throw error
      }
      finally {
        if (streamIdleTimer)
          clearTimeout(streamIdleTimer)
        // TODO: Record errors on llmSpan
        llmSpan.end()
      }

      // Idle give-up: the stream either rejected via our abort, or its promise
      // never settled and streamGaveUp won the race. Either way keep whatever
      // partial reply already arrived and tell the user, once.
      if (streamIdleAborted) {
        console.warn(`[chat] stream idle-aborted after ${STREAM_IDLE_TIMEOUT_MS}ms of silence; keeping partial reply.`)
        const notice = '\n\n(모델이 응답 도중 멈춰서 중단했어. 다시 시도해줘.)'
        fullText += notice
        buildingMessage.content += notice
        buildingMessage.slices.push({ type: 'text', text: notice })
      }

      setTurnPhase('persist')
      await parser.end()

      if (!isStaleGeneration()) {
        if (buildingMessage.slices.length > 0) {
          chatSession.appendSessionMessage(sessionId, toRaw(buildingMessage))
        }
        else if (nativeReasoning.trim() || buildingMessage.categorization?.reasoning?.trim()) {
          // Reasoning-only turn: the model spent its entire output on
          // reasoning and never produced reply content. Previously nothing
          // was persisted (slices empty), so the turn vanished without a
          // trace and looked like a hang. Keep the message (its reasoning is
          // viewable in the collapsible section) plus a visible notice.
          const notice = '(추론만 하고 응답 본문 없이 끝났어. 다시 한번 물어봐줘.)'
          buildingMessage.content += notice
          buildingMessage.slices.push({ type: 'text', text: notice })
          chatSession.appendSessionMessage(sessionId, toRaw(buildingMessage))
          updateUI()
        }
        else {
          // Completely empty stream: surface a retriable error item instead
          // of silently dropping the turn.
          chatSession.appendSessionMessage(sessionId, {
            role: 'error',
            content: '모델이 빈 응답을 반환했어. 다시 시도해줘.',
            createdAt: Date.now(),
            id: nanoid(),
          })
        }
      }

      // Post-stream hooks. Each is labeled so the watchdog can name a hung hook
      // (these run registered side effects — speech, mods, telemetry — any of
      // which could await a slow/dead service and stall the turn).
      setTurnPhase('hooks:streamEnd')
      await hooks.emitStreamEndHooks(streamingMessageContext)
      setTurnPhase('hooks:responseEnd')
      await hooks.emitAssistantResponseEndHooks(fullText, streamingMessageContext)

      setTurnPhase('hooks:afterSend')
      await hooks.emitAfterSendHooks(sendingMessage, streamingMessageContext)
      setTurnPhase('hooks:assistantMessage')
      await hooks.emitAssistantMessageHooks({ ...buildingMessage }, fullText, streamingMessageContext)
      setTurnPhase('hooks:turnComplete')
      await hooks.emitChatTurnCompleteHooks({
        output: { ...buildingMessage },
        outputText: fullText,
        toolCalls: sessionMessagesForSend.filter(msg => msg.role === 'tool') as ToolMessage[],
      }, streamingMessageContext)
      setTurnPhase('done')

      // --- AUTONOMOUS ARTISTRY HOOK (ASSISTANT-CENTRIC) ---
      const artistry = cardStore.activeCard?.extensions?.airi?.modules?.artistry
      if (artistry?.autonomousEnabled && artistry?.autonomousTarget === 'assistant') {
        void artistryAutonomousStore.runArtistTask(fullText, sessionMessagesForSend as any)
      }
      // ---------------------------------------------------

      if (isForegroundSession()) {
        streamingMessage.value = { role: 'assistant', content: '', slices: [], tool_results: [] }
      }
    }
    catch (error) {
      console.error('Error sending message:', error)
      throw error
    }
    finally {
      if (!hadExistingTurn && activeTurnSpan.value) {
        activeTurnSpan.value.end()
        activeTurnSpan.value = undefined
      }
      sending.value = false
    }
  }

  async function ingest(
    sendingMessage: string,
    options: SendOptions,
    targetSessionId?: string,
  ) {
    const sessionId = targetSessionId || activeSessionId.value
    const generation = chatSession.getSessionGeneration(sessionId)

    return new Promise<void>((resolve, reject) => {
      sendQueue.enqueue({
        sendingMessage,
        options,
        generation,
        sessionId,
        deferred: { resolve, reject },
      })
    })
  }

  async function ingestOnFork(
    sendingMessage: string,
    options: SendOptions,
    forkOptions?: ForkOptions,
  ) {
    const baseSessionId = forkOptions?.fromSessionId ?? activeSessionId.value
    if (!forkOptions)
      return ingest(sendingMessage, options, baseSessionId)

    const forkSessionId = await chatSession.forkSession({
      fromSessionId: baseSessionId,
      atIndex: forkOptions.atIndex,
      reason: forkOptions.reason,
      hidden: forkOptions.hidden,
    })
    return ingest(sendingMessage, options, forkSessionId || baseSessionId)
  }

  function cancelPendingSends(sessionId?: string) {
    for (const queued of pendingQueuedSends.value) {
      if (sessionId && queued.sessionId !== sessionId)
        continue

      queued.cancelled = true
      queued.deferred.reject(new Error('Chat session was reset before send could start'))
    }

    pendingQueuedSends.value = sessionId
      ? pendingQueuedSends.value.filter(item => item.sessionId !== sessionId)
      : []
  }

  function getPendingQueuedSendSnapshot() {
    return pendingQueuedSends.value.map(queued => ({
      sessionId: queued.sessionId,
      generation: queued.generation,
      cancelled: !!queued.cancelled,
      messagePreview: queued.sendingMessage.slice(0, 120),
      hasAttachments: !!queued.options.attachments?.length,
      inputType: queued.options.input?.type,
    } satisfies QueuedSendSnapshot))
  }

  return {
    sending,
    pendingQueuedSendCount,

    ingest,
    ingestOnFork,
    cancelPendingSends,
    getPendingQueuedSendSnapshot,

    clearHooks: hooks.clearHooks,

    emitBeforeMessageComposedHooks: hooks.emitBeforeMessageComposedHooks,
    emitAfterMessageComposedHooks: hooks.emitAfterMessageComposedHooks,
    emitBeforeSendHooks: hooks.emitBeforeSendHooks,
    emitAfterSendHooks: hooks.emitAfterSendHooks,
    emitTokenLiteralHooks: hooks.emitTokenLiteralHooks,
    emitTokenSpecialHooks: hooks.emitTokenSpecialHooks,
    emitStreamEndHooks: hooks.emitStreamEndHooks,
    emitAssistantResponseEndHooks: hooks.emitAssistantResponseEndHooks,
    emitAssistantMessageHooks: hooks.emitAssistantMessageHooks,
    emitChatTurnCompleteHooks: hooks.emitChatTurnCompleteHooks,

    onBeforeMessageComposed: hooks.onBeforeMessageComposed,
    onAfterMessageComposed: hooks.onAfterMessageComposed,
    onBeforeSend: hooks.onBeforeSend,
    onAfterSend: hooks.onAfterSend,
    onTokenLiteral: hooks.onTokenLiteral,
    onTokenSpecial: hooks.onTokenSpecial,
    onStreamEnd: hooks.onStreamEnd,
    onAssistantResponseEnd: hooks.onAssistantResponseEnd,
    onAssistantMessage: hooks.onAssistantMessage,
    onChatTurnComplete: hooks.onChatTurnComplete,
  }
})
