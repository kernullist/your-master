/** Lifecycle state a stage scene reports to its host (drives the Loading overlay). */
export type StageComponentState = 'pending' | 'loading' | 'mounted'

/**
 * Snapshot of an `<img>` element's readiness, decoupled from the DOM so the
 * state decision can be unit-tested without a real image or browser.
 */
export interface ImageReadiness {
  /** Whether a non-empty source is currently set on the scene. */
  hasSrc: boolean
  /** The element's `HTMLImageElement.complete` flag. */
  complete: boolean
  /** The element's `HTMLImageElement.naturalWidth` (0 until a frame decodes). */
  naturalWidth: number
}

/**
 * Resolves the stage component state for a static-image avatar from the image's
 * readiness.
 *
 * Use when:
 * - Deciding whether the host should still show the "Loading..." overlay for
 *   the image renderer, both on mount and whenever the source changes.
 *
 * Expects:
 * - `naturalWidth` is 0 until the browser has decoded at least one frame; a
 *   cached image can be `complete` with a non-zero width on the very first
 *   tick, in which case the `load` event may never fire again.
 *
 * Returns:
 * - `'pending'` when there is no source (nothing to show yet),
 * - `'mounted'` when the image is already fully decoded (no Loading flash),
 * - `'loading'` while a source is set but not yet decoded.
 */
export function resolveImageSceneState(readiness: ImageReadiness): StageComponentState {
  if (!readiness.hasSrc) {
    return 'pending'
  }

  if (readiness.complete && readiness.naturalWidth > 0) {
    return 'mounted'
  }

  return 'loading'
}
