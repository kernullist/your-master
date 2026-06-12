<script setup lang="ts">
import type { ChatAssistantMessage, ChatHistoryItem, ContextMessage } from '../../../../types/chat'

import { computed, provide, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import ChatAssistantItem from './assistant-item.vue'
import ChatErrorItem from './error-item.vue'
import ChatUserItem from './user-item.vue'

import { useChatHistoryScroll } from '../composables/use-chat-history-scroll'
import { chatScrollContainerKey } from '../constants'
import { getChatHistoryItemKey } from '../utils'

const props = withDefaults(defineProps<{
  messages: ChatHistoryItem[]
  streamingMessage?: ChatAssistantMessage & { createdAt?: number }
  sending?: boolean
  assistantLabel?: string
  userLabel?: string
  errorLabel?: string
  retryLabel?: string
  variant?: 'desktop' | 'mobile'
}>(), {
  sending: false,
  variant: 'desktop',
})

const emit = defineEmits<{
  (e: 'copyMessage', payload: { message: ChatHistoryItem, index: number, key: string | number }): void
  (e: 'deleteMessage', payload: { message: ChatHistoryItem, index: number, key: string | number }): void
  (e: 'retryMessage', payload: { message: ChatHistoryItem, index: number, key: string | number }): void
}>()

const chatHistoryRef = ref<HTMLDivElement>()
provide(chatScrollContainerKey, chatHistoryRef)

const { t } = useI18n()
const labels = computed(() => ({
  assistant: props.assistantLabel ?? t('stage.chat.message.character-name.airi'),
  user: props.userLabel ?? t('stage.chat.message.character-name.you'),
  error: props.errorLabel ?? t('stage.chat.message.character-name.core-system'),
  retry: props.retryLabel ?? t('stage.chat.actions.retry'),
}))

const streaming = computed<ChatAssistantMessage & { context?: ContextMessage } & { createdAt?: number }>(() => props.streamingMessage ?? { role: 'assistant', content: '', slices: [], tool_results: [], createdAt: Date.now() })
const showStreamingPlaceholder = computed(() => (streaming.value.slices?.length ?? 0) === 0 && !streaming.value.content)
const streamingTs = computed(() => streaming.value?.createdAt)
function shouldShowPlaceholder(message: ChatHistoryItem) {
  const ts = streamingTs.value
  if (ts == null)
    return false

  return message.context?.createdAt === ts || message.createdAt === ts
}
const renderMessages = computed<ChatHistoryItem[]>(() => {
  if (!props.sending)
    return props.messages

  const streamTs = streamingTs.value
  if (!streamTs)
    return props.messages

  const hasStreamAlready = streamTs && props.messages.some(msg => msg?.role === 'assistant' && msg?.createdAt === streamTs)
  if (hasStreamAlready)
    return props.messages

  return [...props.messages, streaming.value]
})

useChatHistoryScroll({
  containerRef: chatHistoryRef,
  messages: renderMessages,
  getKey: getChatHistoryItemKey,
})

// Day dividers: only roles that render a visible bubble participate, so a
// leading system message never produces (or suppresses) a divider.
const visibleDividerRoles = new Set(['user', 'assistant', 'error'])

const { locale } = useI18n()
const dayLabelFormatter = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }))

// Local-timezone calendar-day key; avoids UTC day flips near midnight that
// a `toISOString().slice(0, 10)` approach would produce.
function dayKeyOf(ts?: number) {
  if (ts == null)
    return null

  const date = new Date(ts)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

// One label per message index; non-null marks "first visible message of a new
// calendar day". Precomputed so the template stays O(n).
const dividerLabels = computed<(string | null)[]>(() => {
  let previousDayKey: string | null = null

  return renderMessages.value.map((message) => {
    if (!visibleDividerRoles.has(message.role) || message.createdAt == null)
      return null

    const currentDayKey = dayKeyOf(message.createdAt)
    if (!currentDayKey || currentDayKey === previousDayKey)
      return null

    previousDayKey = currentDayKey
    return dayLabelFormatter.value.format(message.createdAt)
  })
})

function emitCopyMessage(message: ChatHistoryItem, index: number) {
  emit('copyMessage', {
    message,
    index,
    key: getChatHistoryItemKey(message, index),
  })
}

function emitDeleteMessage(message: ChatHistoryItem, index: number) {
  emit('deleteMessage', {
    message,
    index,
    key: getChatHistoryItemKey(message, index),
  })
}

function emitRetryMessage(message: ChatHistoryItem, index: number) {
  emit('retryMessage', {
    message,
    index,
    key: getChatHistoryItemKey(message, index),
  })
}
</script>

<template>
  <div ref="chatHistoryRef" v-auto-animate flex="~ col" relative h-full w-full overflow-y-auto rounded-xl px="<sm:2" py="<sm:2" :class="variant === 'mobile' ? 'gap-1' : 'gap-2'">
    <template v-for="(message, index) in renderMessages" :key="getChatHistoryItemKey(message, index)">
      <div
        v-if="dividerLabels[index]"
        data-chat-day-divider
        :class="['flex items-center gap-3 px-2 py-1', 'select-none']"
      >
        <div :class="['h-px flex-1', 'bg-neutral-300/50 dark:bg-neutral-700/50']" />
        <span :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">{{ dividerLabels[index] }}</span>
        <div :class="['h-px flex-1', 'bg-neutral-300/50 dark:bg-neutral-700/50']" />
      </div>
      <div
        :data-chat-message-index="index"
        :data-chat-message-key="String(getChatHistoryItemKey(message, index))"
        :data-chat-message-role="message.role"
      >
        <ChatErrorItem
          v-if="message.role === 'error'"
          :message="message"
          :label="labels.error"
          :retry-label="labels.retry"
          :can-retry="renderMessages[index - 1]?.role === 'user'"
          :show-placeholder="sending && index === renderMessages.length - 1"
          :variant="variant"
          @copy="emitCopyMessage(message, index)"
          @retry="emitRetryMessage(message, index)"
          @delete="emitDeleteMessage(message, index)"
        />
        <ChatAssistantItem
          v-else-if="message.role === 'assistant'"
          :message="message"
          :label="labels.assistant"
          :show-placeholder="shouldShowPlaceholder(message) && showStreamingPlaceholder"
          :streaming="sending && shouldShowPlaceholder(message)"
          :variant="variant"
          @copy="emitCopyMessage(message, index)"
          @delete="emitDeleteMessage(message, index)"
        />
        <ChatUserItem
          v-else-if="message.role === 'user'"
          :message="message"
          :label="labels.user"
          :variant="variant"
          @copy="emitCopyMessage(message, index)"
          @delete="emitDeleteMessage(message, index)"
        />
      </div>
    </template>
  </div>
</template>
