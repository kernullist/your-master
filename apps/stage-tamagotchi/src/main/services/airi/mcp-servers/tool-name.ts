/**
 * Pure tool-name helpers for the MCP stdio manager. Kept free of `electron`
 * imports so they stay unit-testable in plain Node.
 */

/** Separator between server name and tool name in qualified names. */
export const toolNameSeparator = '::'

/**
 * Parses a qualified MCP tool name.
 *
 * Use when:
 * - Routing a `builtIn_mcpCallTool` invocation to the owning server session.
 *
 * Expects:
 * - `name` in `<serverName>::<toolName>` form; throws on malformed input.
 *
 * Returns:
 * - `{ serverName, toolName }` split at the first separator.
 */
export function parseQualifiedToolName(name: string) {
  const separatorIndex = name.indexOf(toolNameSeparator)
  if (separatorIndex <= 0 || separatorIndex === name.length - toolNameSeparator.length) {
    throw new Error(`invalid qualified tool name: ${name}`)
  }

  return {
    serverName: name.slice(0, separatorIndex),
    toolName: name.slice(separatorIndex + toolNameSeparator.length),
  }
}

/**
 * Normalizes a model-mangled tool name by stripping bogus transport prefixes
 * (e.g. `stdio::`) or taking the tail of a nested qualified name.
 *
 * Before:
 * - "stdio::tavily_search"
 * - "tavily::tavily_search" (nested, already stripped of server once)
 *
 * After:
 * - "tavily_search"
 */
export function resolveFallbackToolName(toolName: string): string | undefined {
  const normalizedTransportPrefix = toolName
    .replace(/^\.(?:stdio|stdo)::/, '')
    .replace(/^(?:stdio|stdo)::/, '')
  if (normalizedTransportPrefix !== toolName) {
    return normalizedTransportPrefix
  }

  const lastSeparatorIndex = toolName.lastIndexOf(toolNameSeparator)
  if (lastSeparatorIndex <= 0 || lastSeparatorIndex === toolName.length - toolNameSeparator.length) {
    return undefined
  }

  return toolName.slice(lastSeparatorIndex + toolNameSeparator.length)
}

/**
 * Normalizes tool-name spelling for comparisons.
 *
 * Before:
 * - "Tavily-Search"
 *
 * After:
 * - "tavily_search"
 */
function normalizeToolName(value: string): string {
  return value.toLowerCase().replace(/-/g, '_')
}

/**
 * Resolves a requested-but-unknown tool name against a server's live tool
 * list.
 *
 * Use when:
 * - A model abbreviated or mangled a tool name (e.g. called
 *   `tavily::search` while the server exposes `tavily_search`) and the call
 *   failed; resolving locally saves a whole LLM round-trip.
 *
 * Expects:
 * - `available` to be the server's current tool names (unqualified).
 *
 * Returns:
 * - The matching available name, found via (in order): transport-prefix
 *   stripping, case/hyphen-insensitive exact match, or a UNIQUE
 *   `*_<requested>` suffix match. `undefined` when nothing matches
 *   unambiguously.
 */
export function resolveRequestedToolName(requested: string, available: string[]): string | undefined {
  const candidates: string[] = []

  const fallback = resolveFallbackToolName(requested)
  if (fallback) {
    candidates.push(fallback)
  }

  const normalizedRequested = normalizeToolName(requested)
  for (const name of available) {
    if (normalizeToolName(name) === normalizedRequested) {
      candidates.push(name)
    }
  }

  // Unique suffix match: "search" -> "tavily_search". The underscore in the
  // pattern keeps near-misses out (e.g. "tavily_research" does not end with
  // "_search").
  const suffixMatches = available.filter(name => normalizeToolName(name).endsWith(`_${normalizedRequested}`))
  if (suffixMatches.length === 1) {
    candidates.push(suffixMatches[0])
  }

  return candidates.find(candidate => available.includes(candidate))
}
