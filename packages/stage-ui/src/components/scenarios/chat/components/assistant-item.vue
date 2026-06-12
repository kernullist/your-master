<script setup lang="ts">
import type { ChatAssistantMessage, ChatHistoryItem, ChatSlices, ChatSlicesText } from '../../../../types/chat'

import { isStageCapacitor, isStageWeb } from '@proj-airi/stage-shared'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import ChatResponsePart from './response-part.vue'
import ChatToolCallBlock from './tool-call-block.vue'

import { MarkdownRenderer } from '../../../markdown'
import { getChatHistoryItemCopyText } from '../utils'
import { ChatActionMenu } from './action-menu'

const props = withDefaults(defineProps<{
  message: ChatAssistantMessage
  label: string
  showPlaceholder?: boolean
  /**
   * Whether this message is the one currently being streamed. Used to decide
   * if a tool call without a matching result is still `executing` (streaming)
   * or simply has no recorded result (finalized history).
   */
  streaming?: boolean
  variant?: 'desktop' | 'mobile'
}>(), {
  showPlaceholder: false,
  streaming: false,
  variant: 'desktop',
})

const emit = defineEmits<{
  (e: 'copy'): void
  (e: 'delete'): void
}>()

const { t } = useI18n()

const resolvedSlices = computed<ChatSlices[]>(() => {
  if (props.message.slices?.length) {
    return props.message.slices
  }

  if (typeof props.message.content === 'string' && props.message.content.trim()) {
    return [{ type: 'text', text: props.message.content } satisfies ChatSlicesText]
  }

  if (Array.isArray(props.message.content)) {
    const textPart = props.message.content.find(part => 'type' in part && part.type === 'text') as { text?: string } | undefined
    if (textPart?.text)
      return [{ type: 'text', text: textPart.text } satisfies ChatSlicesText]
  }

  return []
})

// Maps tool call ids to their recorded results so each tool-call slice can
// render its lifecycle state (executing / done / error) and inline result.
const toolResultById = computed(() => {
  const map = new Map<string, { isError?: boolean, result?: unknown }>()
  for (const toolResult of props.message.tool_results ?? []) {
    map.set(toolResult.id, toolResult)
  }
  return map
})

function toolCallStateFor(toolCallId: string): 'executing' | 'done' | 'error' | undefined {
  const toolResult = toolResultById.value.get(toolCallId)
  if (toolResult)
    return toolResult.isError ? 'error' : 'done'

  // No result yet: only show the executing spinner while this message is
  // actively streaming, otherwise leave the neutral icon for stale history.
  return props.streaming ? 'executing' : undefined
}

function toolCallResultFor(toolCallId: string) {
  return toolResultById.value.get(toolCallId)?.result
}

const showLoader = computed(() => props.showPlaceholder && resolvedSlices.value.length === 0)
const containerClass = computed(() => props.variant === 'mobile' ? 'mr-0' : 'mr-12')
const boxClasses = computed(() => [
  props.variant === 'mobile' ? 'px-2 py-2 text-sm bg-primary-50/90 dark:bg-primary-950/90' : 'px-3 py-3 bg-primary-50/80 dark:bg-primary-950/80',
])
const copyText = computed(() => getChatHistoryItemCopyText(props.message as ChatHistoryItem))
</script>

<template>
  <div flex :class="containerClass" class="ph-no-capture">
    <ChatActionMenu
      :copy-text="copyText"
      :can-delete="!showPlaceholder"
      @copy="emit('copy')"
      @delete="emit('delete')"
    >
      <template #default="{ setMeasuredElement }">
        <div
          :ref="setMeasuredElement"
          flex="~ col" shadow="sm primary-200/50 dark:none"
          min-w-20 rounded-xl h="unset <sm:fit"
          :class="[
            boxClasses,
            (isStageWeb() || isStageCapacitor()) && props.variant === 'mobile' ? 'select-none sm:select-auto' : '',
          ]"
        >
          <div>
            <span text-sm text="black/60 dark:white/65" font-normal class="inline <sm:hidden">{{ label }}</span>
          </div>
          <div v-if="resolvedSlices.length > 0" class="break-words" text="primary-700 dark:primary-100">
            <template v-for="(slice, sliceIndex) in resolvedSlices" :key="sliceIndex">
              <ChatToolCallBlock
                v-if="slice.type === 'tool-call'"
                :tool-name="slice.toolCall.toolName"
                :args="slice.toolCall.args"
                :state="toolCallStateFor(slice.toolCall.toolCallId)"
                :result="toolCallResultFor(slice.toolCall.toolCallId)"
                class="mb-2"
              />
              <template v-else-if="slice.type === 'tool-call-result'" />
              <template v-else-if="slice.type === 'text'">
                <MarkdownRenderer :content="slice.text" />
              </template>
            </template>
          </div>
          <div v-else-if="showLoader" :class="['flex items-center gap-1.5', 'text-black/45 dark:text-white/50']">
            <div i-eos-icons:three-dots-loading />
            <span :class="['text-xs', 'animate-pulse']">{{ t('stage.chat.thinking') }}</span>
          </div>

          <ChatResponsePart
            v-if="message.categorization"
            :message="message"
            :variant="variant"
          />
        </div>
      </template>
    </ChatActionMenu>
  </div>
</template>
