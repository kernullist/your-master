import type { JsonSchema } from 'xsschema'

import type { McpToolDescriptor } from './mcp'

import { describe, expect, it, vi } from 'vitest'

import { callMcpToolWithTimeout, capMcpToolResult, createFlattenedMcpTools, MAX_MCP_RESULT_CHARS, mcp, normalizeMcpInputSchema, sanitizeMcpToolName } from './mcp'

describe('tools mcp schema', () => {
  it('emits strict parameter objects', async () => {
    const tools = await mcp()
    for (const name of ['builtIn_mcpListTools', 'builtIn_mcpCallTool']) {
      const t = tools.find(entry => entry.function.name === name)
      expect(t, `missing tool: ${name}`).toBeDefined()
      expect(t?.function.parameters.additionalProperties).toBe(false)
    }
  })

  it('builtIn_mcpCallTool uses flat name+arguments schema', async () => {
    const tools = await mcp()
    const callTool = tools.find(entry => entry.function.name === 'builtIn_mcpCallTool')
    expect(callTool).toBeDefined()

    const props = (callTool!.function.parameters as JsonSchema).properties!
    expect((props.name as JsonSchema).type).toBe('string')
    expect((props.arguments as JsonSchema).type).toBe('string')
  })
})

const TAVILY_SEARCH_DESCRIPTOR: McpToolDescriptor = {
  serverName: 'tavily',
  name: 'tavily::tavily_search',
  toolName: 'tavily_search',
  description: 'Search the web for current information on any topic.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
  },
}

describe('sanitizeMcpToolName', () => {
  it('converts qualified names into provider-safe function names', () => {
    expect(sanitizeMcpToolName('tavily::tavily_search', new Set())).toBe('mcp_tavily_tavily_search')
  })

  it('deduplicates collisions with a numeric suffix', () => {
    const taken = new Set<string>()
    expect(sanitizeMcpToolName('a::b', taken)).toBe('mcp_a_b')
    expect(sanitizeMcpToolName('a::b', taken)).toBe('mcp_a_b_2')
  })

  it('strips characters providers reject', () => {
    expect(sanitizeMcpToolName('srv.x::tool name!', new Set())).toBe('mcp_srv_x_tool_name_')
  })
})

describe('normalizeMcpInputSchema', () => {
  it('produces an explicit empty object schema when none is given', () => {
    expect(normalizeMcpInputSchema(undefined)).toEqual({ type: 'object', properties: {} })
  })

  it('keeps an existing schema intact', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
    expect(normalizeMcpInputSchema(schema)).toEqual(schema)
  })
})

// ROOT CAUSE:
//
// MCP tools were only reachable through the generic builtIn_mcpListTools /
// builtIn_mcpCallTool proxy pair. Weak local models either skipped the
// discovery hop entirely (answering factual questions from imagination
// instead of searching) or mangled the qualified name when calling. With the
// tools flattened, `tavily_search`-style entries appear directly in the
// model's tool list with their real descriptions and schemas.
describe('capMcpToolResult', () => {
  // ROOT CAUSE:
  //
  // Tavily web tools (extract/crawl) return whole-page raw_content (57KB-424KB
  // measured). Sent back verbatim as a tool result, that overflowed the LLM
  // context and made LM Studio stall mid-stream or 500 — which is why hangs
  // happened mainly during "web research". Capping the result fixes it.
  it('returns the result unchanged when within budget', () => {
    const result = { content: [{ type: 'text', text: 'short' }] }
    expect(capMcpToolResult(result)).toBe(result)
  })

  it('truncates oversized text content and marks how much was dropped', () => {
    const big = 'a'.repeat(MAX_MCP_RESULT_CHARS + 5000)
    const capped = capMcpToolResult({ content: [{ type: 'text', text: big }] })
    const text = capped.content![0].text as string
    expect(text.length).toBeLessThan(big.length)
    expect(text).toContain('[truncated 5000 chars]')
    expect(text.startsWith('a'.repeat(100))).toBe(true)
  })

  it('caps across multiple blocks and drops the overflow tail', () => {
    const capped = capMcpToolResult({
      content: [
        { type: 'text', text: 'b'.repeat(MAX_MCP_RESULT_CHARS) },
        { type: 'text', text: 'should be dropped' },
      ],
    })
    expect(capped.content).toHaveLength(1)
  })

  it('drops structuredContent when truncating so it cannot smuggle the payload', () => {
    const capped = capMcpToolResult({
      content: [{ type: 'text', text: 'c'.repeat(MAX_MCP_RESULT_CHARS + 1) }],
      structuredContent: { huge: 'x'.repeat(99999) },
    })
    expect(capped.structuredContent).toBeUndefined()
  })

  it('passes through results without a content array', () => {
    const result = { structuredContent: { ok: true } }
    expect(capMcpToolResult(result)).toBe(result)
  })
})

describe('createFlattenedMcpTools', () => {
  it('exposes one first-class tool per MCP descriptor', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'result' }] })
    const tools = await createFlattenedMcpTools({
      listTools: async () => [TAVILY_SEARCH_DESCRIPTOR],
      callTool,
    })

    expect(tools).toHaveLength(1)
    expect(tools[0].function.name).toBe('mcp_tavily_tavily_search')
    expect(tools[0].function.description).toContain('Search the web')
    expect(tools[0].function.parameters).toMatchObject({ type: 'object', required: ['query'] })

    const result = await tools[0].execute!({ query: 'k-league results' }, { toolCallId: 't1', messages: [] })
    expect(callTool).toHaveBeenCalledWith({
      name: 'tavily::tavily_search',
      arguments: { query: 'k-league results' },
    })
    expect(result).toEqual({ content: [{ type: 'text', text: 'result' }] })
  })

  it('returns an error payload instead of throwing when the call fails', async () => {
    const tools = await createFlattenedMcpTools({
      listTools: async () => [TAVILY_SEARCH_DESCRIPTOR],
      callTool: vi.fn().mockRejectedValue(new Error('server gone')),
    })

    const result = await tools[0].execute!({ query: 'x' }, { toolCallId: 't1', messages: [] }) as { isError?: boolean }
    expect(result.isError).toBe(true)
  })

  it('degrades to an empty tool list when listing fails', async () => {
    const tools = await createFlattenedMcpTools({
      listTools: async () => {
        throw new Error('runtime offline')
      },
      callTool: vi.fn(),
    })

    expect(tools).toEqual([])
  })

  // ROOT CAUSE:
  //
  // A web-search MCP call that hangs never emits a `tool-result` stream event.
  // The chat turn pauses its mid-stream idle-abort while a tool runs
  // (pendingToolCalls > 0 in chat.ts), so a stuck call was only recovered by
  // the 180s turn watchdog and surfaced as 'stuck in phase "streaming"'.
  //
  // We fixed this by bounding each MCP call with callMcpToolWithTimeout: a
  // hung call now resolves to an isError tool result, which flows back as a
  // tool-result event, re-arms the idle timer, and ends the turn fast.
  it('returns an isError result when a tool call exceeds the timeout', async () => {
    vi.useFakeTimers()
    try {
      const tools = await createFlattenedMcpTools({
        listTools: async () => [TAVILY_SEARCH_DESCRIPTOR],
        // Never resolves: simulates a hung web-search MCP server.
        callTool: () => new Promise<never>(() => {}),
      }, { callTimeoutMs: 1000 })

      const pending = tools[0].execute!({ query: 'x' }, { toolCallId: 't1', messages: [] }) as Promise<{ isError?: boolean, content?: Array<{ text: string }> }>
      await vi.advanceTimersByTimeAsync(1000)
      const result = await pending

      expect(result.isError).toBe(true)
      expect(result.content![0].text).toContain('timed out after 1000ms')
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('callMcpToolWithTimeout', () => {
  it('returns the tool result when the call resolves before the timeout', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    const result = await callMcpToolWithTimeout({ listTools: async () => [], callTool }, { name: 'srv::tool' }, 1000)

    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] })
  })

  it('resolves to an isError result when the call hangs past the timeout', async () => {
    vi.useFakeTimers()
    try {
      const callTool = vi.fn(() => new Promise<never>(() => {}))
      const pending = callMcpToolWithTimeout({ listTools: async () => [], callTool }, { name: 'srv::tool' }, 500)
      await vi.advanceTimersByTimeAsync(500)
      const result = await pending

      expect(result.isError).toBe(true)
      expect(result.content![0].text as string).toContain('srv::tool')
    }
    finally {
      vi.useRealTimers()
    }
  })
})
