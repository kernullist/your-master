import { toRaw } from 'vue'

/**
 * Deep-clones a value into plain structured data, tolerating Vue reactivity.
 *
 * Use when:
 * - Snapshotting store state for BroadcastChannel / IPC / persistence
 * - The value may contain Vue reactive Proxies anywhere inside it —
 *   `structuredClone` rejects Proxies with DataCloneError
 *   ("# could not be cloned" in Chromium)
 *
 * Expects:
 * - Structured-clonable or JSON-representable data (no functions, DOM nodes,
 *   or circular references on the JSON fallback path)
 *
 * Returns:
 * - A deep plain copy fully detached from Vue reactivity
 */
export function cloneDeepSafe<T>(value: T): T {
  try {
    // toRaw only unwraps the top level; nested Proxies still throw and are
    // handled by the JSON fallback, which reads through Proxies transparently.
    return structuredClone(toRaw(value))
  }
  catch {
    return JSON.parse(JSON.stringify(value)) as T
  }
}
