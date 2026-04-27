/**
 * Normalizes a project issue prefix.
 *
 * Before:
 * - "airi"
 * - "proj airi"
 *
 * After:
 * - "AIRI"
 * - "PROJAIRI"
 */
export function normalizeIssuePrefix(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * Normalizes a work item identifier.
 *
 * Before:
 * - "airi-12"
 * - " AIRI 12 "
 *
 * After:
 * - "AIRI-12"
 * - "AIRI-12"
 */
export function normalizeWorkItemIdentifier(input: string): string {
  const trimmed = input.trim().toUpperCase()
  const compact = trimmed.replace(/\s+/g, '-')
  const numberMatch = compact.match(/\d+$/)
  if (!numberMatch)
    return compact

  const rawPrefix = compact.slice(0, numberMatch.index).replace(/-$/, '')
  if (!/^[A-Z][A-Z0-9]*$/.test(rawPrefix))
    return compact

  return `${rawPrefix}-${Number(numberMatch[0])}`
}

/**
 * Checks whether a work item identifier already exists.
 *
 * Use when:
 * - AIRI needs to ask the user before creating a duplicate identifier
 *
 * Expects:
 * - `identifiers` may contain mixed casing or whitespace from persisted data
 *
 * Returns:
 * - True when normalized identifiers match
 */
export function hasDuplicateIdentifier(identifiers: string[], nextIdentifier: string): boolean {
  const normalized = normalizeWorkItemIdentifier(nextIdentifier)
  return identifiers.some(identifier => normalizeWorkItemIdentifier(identifier) === normalized)
}

/**
 * Creates the next work item identifier for a project prefix.
 *
 * Before:
 * - `issuePrefix: "bc"`, `identifiers: []`
 * - `issuePrefix: "bc"`, `identifiers: ["BC-1", "BC-2"]`
 *
 * After:
 * - `"BC-1"`
 * - `"BC-3"`
 */
export function createNextWorkItemIdentifier(input: {
  issuePrefix: string
  identifiers: string[]
}): string {
  const prefix = normalizeIssuePrefix(input.issuePrefix)
  const matcher = new RegExp(`^${prefix}-(\\d+)$`)
  const maxNumber = input.identifiers.reduce((max, identifier) => {
    const normalized = normalizeWorkItemIdentifier(identifier)
    const match = matcher.exec(normalized)
    if (!match)
      return max

    return Math.max(max, Number(match[1]))
  }, 0)

  return `${prefix}-${maxNumber + 1}`
}
