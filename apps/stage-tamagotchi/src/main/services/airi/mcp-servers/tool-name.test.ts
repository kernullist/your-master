import { describe, expect, it } from 'vitest'

import { parseQualifiedToolName, resolveFallbackToolName, resolveRequestedToolName } from './tool-name'

const TAVILY_TOOLS = ['tavily_search', 'tavily_extract', 'tavily_crawl', 'tavily_map', 'tavily_research']

describe('parseQualifiedToolName', () => {
  it('splits server and tool at the first separator', () => {
    expect(parseQualifiedToolName('tavily::tavily_search')).toEqual({
      serverName: 'tavily',
      toolName: 'tavily_search',
    })
  })

  it('keeps nested separators inside the tool part', () => {
    expect(parseQualifiedToolName('tavily::stdio::tavily_search')).toEqual({
      serverName: 'tavily',
      toolName: 'stdio::tavily_search',
    })
  })

  it('throws on malformed names', () => {
    expect(() => parseQualifiedToolName('tavily_search')).toThrow('invalid qualified tool name')
    expect(() => parseQualifiedToolName('tavily::')).toThrow('invalid qualified tool name')
  })
})

describe('resolveFallbackToolName', () => {
  it('strips bogus transport prefixes', () => {
    expect(resolveFallbackToolName('stdio::tavily_search')).toBe('tavily_search')
    expect(resolveFallbackToolName('.stdio::tavily_search')).toBe('tavily_search')
  })

  it('returns undefined for plain names', () => {
    expect(resolveFallbackToolName('tavily_search')).toBeUndefined()
  })
})

// ROOT CAUSE:
//
// Weak local models abbreviate MCP tool names: with tavily-mcp registered
// the model called `tavily::search` while the server only exposes
// `tavily_search`, so the call failed with an opaque error and web search
// silently did not work. The previous fallback only handled transport-prefix
// mistakes, not abbreviations.
//
// We fixed this by resolving the requested name against the server's live
// tool list (exact normalized match, then unique `_<requested>` suffix) and,
// when nothing matches, raising an error that lists the real tool names so
// the LLM can self-correct on the next round.
describe('resolveRequestedToolName', () => {
  it('resolves an abbreviated name via unique suffix match (Issue: tavily::search)', () => {
    expect(resolveRequestedToolName('search', TAVILY_TOOLS)).toBe('tavily_search')
  })

  it('does not confuse the suffix match with near-misses like tavily_research', () => {
    // "research" must resolve to tavily_research (exact), never tavily_search.
    expect(resolveRequestedToolName('research', TAVILY_TOOLS)).toBe('tavily_research')
  })

  it('matches case- and hyphen-insensitively', () => {
    expect(resolveRequestedToolName('Tavily-Search', TAVILY_TOOLS)).toBe('tavily_search')
  })

  it('resolves transport-prefixed names against the list', () => {
    expect(resolveRequestedToolName('stdio::tavily_search', TAVILY_TOOLS)).toBe('tavily_search')
  })

  it('returns undefined when the suffix match is ambiguous', () => {
    const ambiguous = ['serverA_run', 'serverB_run']
    expect(resolveRequestedToolName('run', ambiguous)).toBeUndefined()
  })

  it('returns undefined when nothing matches', () => {
    expect(resolveRequestedToolName('totally_unknown', TAVILY_TOOLS)).toBeUndefined()
  })
})
