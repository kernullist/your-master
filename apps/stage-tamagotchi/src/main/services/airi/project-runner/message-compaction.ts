import type { AgentChatMessage } from './agent-runtime'

/**
 * Options controlling {@link compactAgentMessages}.
 */
export interface CompactAgentMessagesOptions {
  /**
   * Number of most-recent tool-result messages kept at full fidelity.
   *
   * @default 4
   */
  keepRecentToolResults?: number
  /**
   * Content prefixes that mark a `role: 'user'` message as a tool result the loop appended.
   *
   * @default ['Tool result:', 'Reviewer tool result:']
   */
  toolResultPrefixes?: string[]
  /**
   * A tool result is only cleared when its content is longer than this, so small results survive.
   *
   * @default 400
   */
  minCharsToClear?: number
  /**
   * Compaction only runs when the summed content length exceeds this, so short runs are untouched.
   *
   * @default 24000
   */
  triggerTotalChars?: number
}

const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 4
const DEFAULT_MIN_CHARS_TO_CLEAR = 400
const DEFAULT_TRIGGER_TOTAL_CHARS = 24_000
const DEFAULT_TOOL_RESULT_PREFIXES = ['Tool result:', 'Reviewer tool result:']
/** Characters of the original payload kept as a hint inside a cleared pointer. */
const CLEARED_HEAD_CHARS = 120

function totalContentChars(messages: AgentChatMessage[]): number {
  let total = 0
  for (const message of messages) {
    total += message.content.length
  }
  return total
}

function isToolResultMessage(message: AgentChatMessage, prefixes: string[]): boolean {
  if (message.role !== 'user')
    return false

  return prefixes.some(prefix => message.content.startsWith(prefix))
}

/**
 * Rewrites one bulky tool-result message into a compact reference pointer.
 *
 * Before:
 * - "Tool result:\n<12000 chars of file text>"
 *
 * After:
 * - "Tool result:\n[cleared 11987 chars to save context; head: export function foo() ...]"
 */
function clearToolResultContent(content: string): string {
  const newlineIndex = content.indexOf('\n')
  const label = newlineIndex >= 0 ? content.slice(0, newlineIndex) : content
  const payload = newlineIndex >= 0 ? content.slice(newlineIndex + 1) : ''
  const head = payload.slice(0, CLEARED_HEAD_CHARS).replace(/\s+/g, ' ').trim()
  const ellipsis = payload.length > CLEARED_HEAD_CHARS ? ' ...' : ''
  return `${label}\n[cleared ${payload.length} chars to save context; head: ${head}${ellipsis}]`
}

/**
 * Clears stale tool-result messages so a long worker/reviewer loop does not rot its own context.
 *
 * The system prompt and the first user message (the task) are always preserved so the request
 * prefix stays stable and prompt caching can still hit. Every assistant message (the model's
 * decisions and reasoning) is preserved. Only tool-result `role: 'user'` messages beyond the most
 * recent {@link CompactAgentMessagesOptions.keepRecentToolResults} are replaced with a one-line
 * pointer, which the agent can regenerate by re-running the tool if it needs the detail again.
 *
 * Use when:
 * - Building the message array to send for one step of a multi-step agent loop
 * - Raw tool outputs accumulate across many steps and would otherwise overflow the window
 *
 * Expects:
 * - `messages[0]` is the system prompt and `messages[1]` (if present) is the task message
 * - Tool results were appended as `role: 'user'` messages starting with a known prefix
 *
 * Returns:
 * - A new array (input is not mutated); unchanged when total content is under the trigger threshold
 *
 * Call stack:
 *
 * runWorkerWithTools / runReviewerAgent (./orchestrator)
 *   -> {@link compactAgentMessages}
 *     -> {@link clearToolResultContent}
 */
export function compactAgentMessages(
  messages: AgentChatMessage[],
  options: CompactAgentMessagesOptions = {},
): AgentChatMessage[] {
  const keepRecent = options.keepRecentToolResults ?? DEFAULT_KEEP_RECENT_TOOL_RESULTS
  const prefixes = options.toolResultPrefixes ?? DEFAULT_TOOL_RESULT_PREFIXES
  const minCharsToClear = options.minCharsToClear ?? DEFAULT_MIN_CHARS_TO_CLEAR
  const triggerTotalChars = options.triggerTotalChars ?? DEFAULT_TRIGGER_TOTAL_CHARS

  if (totalContentChars(messages) <= triggerTotalChars)
    return messages

  const toolResultIndexes = messages
    .map((message, index) => (isToolResultMessage(message, prefixes) ? index : -1))
    .filter(index => index >= 0)

  // Indexes of tool results that must stay at full fidelity (the most recent ones).
  const protectedIndexes = new Set(toolResultIndexes.slice(Math.max(0, toolResultIndexes.length - keepRecent)))

  return messages.map((message, index) => {
    if (!toolResultIndexes.includes(index) || protectedIndexes.has(index))
      return message
    if (message.content.length <= minCharsToClear)
      return message

    return {
      role: message.role,
      content: clearToolResultContent(message.content),
    }
  })
}
