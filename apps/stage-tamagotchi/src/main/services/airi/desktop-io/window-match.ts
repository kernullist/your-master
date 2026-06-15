/**
 * Picks the window source whose title best matches a query, for window-targeted
 * screenshots. Match is case-insensitive substring; among matches the shortest
 * title wins because a substring hit on a shorter title is the more specific one
 * (it avoids selecting a window that only contains the query as part of a longer,
 * unrelated title).
 *
 * Use when:
 * - Resolving a user-supplied window name (e.g. "VMware") to a single capturable
 *   window among the open windows enumerated by desktopCapturer.
 *
 * Expects:
 * - `sources` each carry a `name` (the window title); `query` is the raw,
 *   possibly-untrimmed user input.
 *
 * Returns:
 * - The best-matching source, or undefined when the query is empty or nothing
 *   matches.
 *
 * Generic `T` only requires a `name`, so real desktopCapturer sources and test
 * stubs both satisfy it.
 *
 * @example selectWindowSource([{ name: 'Chrome' }, { name: 'VMware Workstation' }], 'vmware')
 *   -> { name: 'VMware Workstation' }
 * @example selectWindowSource([{ name: 'Notepad' }], 'vmware') -> undefined
 */
export function selectWindowSource<T extends { name: string }>(sources: T[], query: string): T | undefined {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return undefined
  }

  let best: T | undefined
  for (const source of sources) {
    if (!source.name.toLowerCase().includes(needle)) {
      continue
    }
    // Prefer the shortest matching title (most specific match).
    if (!best || source.name.length < best.name.length) {
      best = source
    }
  }
  return best
}
