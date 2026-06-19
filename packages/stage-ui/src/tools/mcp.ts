import type { Tool } from '@xsai/shared-chat'

import { errorMessageFrom } from '@moeru/std'
import { rawTool, tool } from '@xsai/tool'
import { z } from 'zod'

/**
 * Describes an MCP tool that can be exposed to the shared LLM runtime.
 *
 * Use when:
 * - A runtime needs to list available MCP tools before exposing them to models
 *
 * Expects:
 * - `name` is the fully-qualified tool name used for invocation
 *
 * Returns:
 * - The MCP tool descriptor metadata reported by the runtime
 */
export interface McpToolDescriptor {
  serverName: string
  name: string
  toolName: string
  description?: string
  inputSchema: Record<string, unknown>
}

/**
 * Payload for invoking an MCP tool through a runtime-specific transport.
 *
 * Use when:
 * - A runtime needs to forward a tool invocation into the MCP layer
 *
 * Expects:
 * - `name` matches a descriptor returned from `listTools`
 * - `arguments` is a JSON-compatible object when provided
 *
 * Returns:
 * - The MCP tool call input envelope
 */
export interface McpCallToolPayload {
  name: string
  arguments?: Record<string, unknown>
}

/**
 * Result returned from an MCP tool invocation.
 *
 * Use when:
 * - An MCP runtime returns tool output back to the shared LLM layer
 *
 * Expects:
 * - Error responses set `isError` when the tool execution failed
 *
 * Returns:
 * - Structured and unstructured MCP tool output
 */
export interface McpCallToolResult {
  content?: Array<Record<string, unknown>>
  structuredContent?: Record<string, unknown>
  toolResult?: unknown
  isError?: boolean
}

/**
 * Max characters of MCP tool-result text fed back to the model. Web tools
 * (e.g. Tavily extract/crawl) return whole-page `raw_content` — measured at
 * 57KB-424KB per call — which, sent back as a tool result, blows up the LLM
 * context and makes local servers (LM Studio/llama.cpp) stall mid-stream or
 * return 500. Capping keeps enough content to answer while protecting the
 * context. ~12K chars is roughly 3-4K tokens.
 */
export const MAX_MCP_RESULT_CHARS = 12_000

/**
 * Caps the total text size of an MCP tool result so a huge payload cannot
 * overflow the model context. Walks `content` text blocks, truncating once the
 * budget is exhausted and marking how much was dropped; non-text blocks pass
 * through. Returns the original object unchanged when already within budget.
 *
 * Before:
 * - { content: [{ type: 'text', text: <424KB page dump> }] }
 *
 * After:
 * - { content: [{ type: 'text', text: '<first 12K chars>\n...[truncated N chars]' }] }
 */
export function capMcpToolResult<T extends McpCallToolResult>(result: T, maxChars = MAX_MCP_RESULT_CHARS): T {
  if (!result || !Array.isArray(result.content)) {
    return result
  }

  let used = 0
  let truncated = false
  const content: Array<Record<string, unknown>> = []
  for (const block of result.content) {
    if (used >= maxChars) {
      truncated = true
      break
    }
    if (block && block.type === 'text' && typeof block.text === 'string') {
      const text = block.text
      const remaining = maxChars - used
      if (text.length > remaining) {
        content.push({ ...block, text: `${text.slice(0, remaining)}\n...[truncated ${text.length - remaining} chars]` })
        used = maxChars
        truncated = true
      }
      else {
        content.push(block)
        used += text.length
      }
    }
    else {
      content.push(block)
    }
  }

  if (!truncated) {
    return result
  }
  // Drop structuredContent when truncating: it can carry the same oversized
  // payload and would defeat the cap if the model reads it.
  const { structuredContent: _dropped, ...rest } = result
  return { ...rest, content } as T
}

/**
 * Runtime contract for wiring MCP tool discovery and execution into `stage-ui`.
 *
 * Use when:
 * - A concrete runtime such as Electron needs to provide MCP access without a singleton bridge
 *
 * Expects:
 * - `listTools` and `callTool` are safe to call multiple times
 *
 * Returns:
 * - An object that can back `createMcpTools`
 */
export interface McpToolRuntime {
  listTools: () => Promise<McpToolDescriptor[]>
  callTool: (payload: McpCallToolPayload) => Promise<McpCallToolResult>
}

/**
 * Default time budget for a single MCP tool invocation before it is treated as
 * failed. A hung web-search/extract call never emits a `tool-result` stream
 * event, and the chat turn pauses its mid-stream idle-abort while a tool is
 * running, so without a bound only the 180s turn watchdog recovers and the UI
 * shows "stuck in phase streaming". Bounding the call surfaces a fast,
 * retriable tool error instead. Kept well under the turn watchdog so recovery
 * happens long before the turn is abandoned.
 */
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 45_000

/**
 * Invokes an MCP tool with a hard time budget.
 *
 * Use when:
 * - Executing an MCP tool whose transport (network / MCP server) may hang
 *   without responding, which would otherwise stall the entire chat turn.
 *
 * Expects:
 * - `runtime.callTool` may never resolve; `timeoutMs` is a positive duration.
 *
 * Returns:
 * - The tool result, or an `isError` result when the call exceeds `timeoutMs`.
 */
export async function callMcpToolWithTimeout(
  runtime: McpToolRuntime,
  payload: McpCallToolPayload,
  timeoutMs = DEFAULT_MCP_CALL_TIMEOUT_MS,
): Promise<McpCallToolResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<McpCallToolResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        isError: true,
        content: [{ type: 'text', text: `MCP tool "${payload.name}" timed out after ${timeoutMs}ms` }],
      })
    }, timeoutMs)
  })

  // NOTICE:
  // McpToolRuntime.callTool takes no AbortSignal, so a timed-out call cannot be
  // cancelled and keeps running in the background. Attach a no-op catch so its
  // late rejection (after the race already settled on the timeout) does not
  // surface as an unhandled rejection. Recovering the turn is worth the leaked
  // in-flight request.
  // Removal condition: McpToolRuntime.callTool accepts an AbortSignal.
  const call = runtime.callTool(payload)
  call.catch(() => {})

  try {
    return await Promise.race([call, timeout])
  }
  finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/**
 * Creates MCP proxy tools backed by a runtime-provided transport.
 *
 * Use when:
 * - A runtime wants to register MCP tools into the shared LLM tool store
 *
 * Expects:
 * - The runtime implements the `McpToolRuntime` contract
 *
 * Returns:
 * - xsai tool definition promises for MCP listing and invocation
 *
 * @param runtime - MCP transport used to list and call tools.
 * @param options - Optional overrides.
 * @param options.callTimeoutMs - Per-call time budget; defaults to {@link DEFAULT_MCP_CALL_TIMEOUT_MS}.
 */
export function createMcpTools(runtime: McpToolRuntime, options: { callTimeoutMs?: number } = {}): Array<Promise<Tool>> {
  const { callTimeoutMs = DEFAULT_MCP_CALL_TIMEOUT_MS } = options
  return [
    tool({
      name: 'builtIn_mcpListTools',
      description: 'List all available MCP tools. Call this first to discover tool names before calling builtIn_mcpCallTool.',
      execute: async () => {
        try {
          return await runtime.listTools()
        }
        catch (error) {
          console.warn('[builtIn_mcpListTools] failed to list tools:', error)
          return ''
        }
      },
      parameters: z.object({}).strict(),
    }),
    tool({
      name: 'builtIn_mcpCallTool',
      description: 'Call an MCP tool by name. Use builtIn_mcpListTools first to get available tool names.',
      execute: async ({ name, arguments: argsJson }) => {
        try {
          const args = argsJson ? JSON.parse(argsJson) : {}
          return capMcpToolResult(await callMcpToolWithTimeout(runtime, { name, arguments: args }, callTimeoutMs))
        }
        catch (error) {
          return {
            isError: true,
            content: [{ type: 'text', text: errorMessageFrom(error) ?? String(error) }],
          }
        }
      },
      // NOTICE: `arguments` is z.string() (JSON) because z.unknown() produces `{}` (no `type` key)
      // and z.record() emits `propertyNames`, both rejected by OpenAI.
      parameters: z.object({
        name: z.string().describe('Tool name in "<serverName>::<toolName>" format'),
        arguments: z.string().describe('JSON object of tool arguments, e.g. {"query":"hello","limit":10}'),
      }).strict(),
    }),
  ]
}

/**
 * Normalizes a qualified MCP tool name into a provider-safe function name.
 *
 * Provider APIs (OpenAI-compatible included) restrict tool names to
 * `[a-zA-Z0-9_-]`, so the `server::tool` form cannot be exposed directly —
 * which is why the generic call-by-name proxy existed. Flattened tools need
 * a sanitized name instead.
 *
 * Before:
 * - "tavily::tavily_search"
 *
 * After:
 * - "mcp_tavily_tavily_search"
 */
export function sanitizeMcpToolName(qualifiedName: string, taken: Set<string>): string {
  const base = `mcp_${qualifiedName}`
    .replace(/[^\w-]/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 60)

  let candidate = base
  let suffix = 1
  while (taken.has(candidate)) {
    suffix += 1
    candidate = `${base}_${suffix}`
  }

  taken.add(candidate)
  return candidate
}

/**
 * Normalizes an MCP-reported input schema into a provider-compliant shape.
 *
 * Before:
 * - undefined, or a schema missing `type` / `properties`
 *
 * After:
 * - An object schema with explicit `type: 'object'` and a `properties` map,
 *   which strict providers (OpenAI et al.) require.
 */
export function normalizeMcpInputSchema(schema?: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = schema && typeof schema === 'object' ? { ...schema } : {}
  base.type ??= 'object'
  if (base.type === 'object' && base.properties == null) {
    base.properties = {}
  }
  return base
}

/**
 * Flattens live MCP tools into first-class xsai tools, one per MCP tool.
 *
 * Use when:
 * - Building the per-session tool list once MCP servers are running. The
 *   generic list/call proxy pair requires a two-hop discovery flow that weak
 *   local models rarely execute correctly (they skip the list call or mangle
 *   the qualified name); flattened tools put the real name, description and
 *   input schema directly into the model's tool list.
 *
 * Expects:
 * - `runtime.listTools()` to reflect currently running servers; a listing
 *   failure degrades to an empty array instead of throwing.
 *
 * Returns:
 * - One tool per MCP descriptor, executing through `runtime.callTool` with
 *   the original qualified name.
 *
 * @param runtime - MCP transport used to list and call tools.
 * @param options - Optional overrides.
 * @param options.callTimeoutMs - Per-call time budget; defaults to {@link DEFAULT_MCP_CALL_TIMEOUT_MS}.
 */
export async function createFlattenedMcpTools(runtime: McpToolRuntime, options: { callTimeoutMs?: number } = {}): Promise<Tool[]> {
  const { callTimeoutMs = DEFAULT_MCP_CALL_TIMEOUT_MS } = options
  let descriptors: McpToolDescriptor[]
  try {
    descriptors = await runtime.listTools()
  }
  catch (error) {
    console.warn('[createFlattenedMcpTools] failed to list tools, exposing none:', error)
    return []
  }

  const taken = new Set<string>()
  return descriptors.map(descriptor => rawTool({
    name: sanitizeMcpToolName(descriptor.name, taken),
    description: descriptor.description?.trim() || `MCP tool "${descriptor.toolName}" from server "${descriptor.serverName}".`,
    execute: async (params) => {
      try {
        return capMcpToolResult(await callMcpToolWithTimeout(runtime, {
          name: descriptor.name,
          arguments: (params ?? {}) as Record<string, unknown>,
        }, callTimeoutMs))
      }
      catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: errorMessageFrom(error) ?? String(error) }],
        }
      }
    },
    parameters: normalizeMcpInputSchema(descriptor.inputSchema) as never,
    // NOTICE:
    // strict defaults to true, which rewrites the schema via strictJsonSchema
    // (all properties forced into `required`, additionalProperties: false).
    // MCP servers commonly declare optional parameters, so strict mode would
    // make calls with omitted optionals invalid. Keep the server's schema.
    // Source: node_modules/@xsai/tool/dist/index.js (rawTool).
    // Removal condition: xsai exposes per-parameter strictness control.
    strict: false,
  }))
}

function createUnavailableMcpToolRuntime(): McpToolRuntime {
  return {
    async listTools() {
      throw new Error('MCP tools are not available in this runtime.')
    },
    async callTool() {
      throw new Error('MCP tools are not available in this runtime.')
    },
  }
}

/**
 * Builds the default stage-ui MCP tool set without depending on runtime singletons.
 *
 * Use when:
 * - Shared code needs the MCP tool schema before a concrete runtime registers live implementations
 *
 * Expects:
 * - Runtime-specific callers override these tools through `useLlmToolsStore`
 *
 * Returns:
 * - MCP tool definitions with an unavailable-runtime fallback
 */
export async function mcp(): Promise<Tool[]> {
  return await Promise.all(createMcpTools(createUnavailableMcpToolRuntime()))
}
