import { describe, expect, it } from 'vitest'

import { resolveImageSceneState } from './image-scene'

// ROOT CAUSE:
//
// ImageScene reached the 'mounted' state only via the <img> `load` event. A
// cached/already-decoded image does not re-fire `load` after the element
// mounts, so the host's "Loading..." overlay could stay over (or flash on top
// of) an image that was actually ready.
//
// We fixed this by reconciling state from the element's complete/naturalWidth
// readiness (resolveImageSceneState) on mount and after each src change, in
// addition to the `load` event.
describe('resolveImageSceneState', () => {
  it('is pending when no source is set', () => {
    expect(resolveImageSceneState({ hasSrc: false, complete: false, naturalWidth: 0 })).toBe('pending')
  })

  it('is pending when no source is set even if a stale element still reports complete', () => {
    expect(resolveImageSceneState({ hasSrc: false, complete: true, naturalWidth: 1024 })).toBe('pending')
  })

  it('is mounted when the image is already complete and decoded (cached)', () => {
    expect(resolveImageSceneState({ hasSrc: true, complete: true, naturalWidth: 1024 })).toBe('mounted')
  })

  it('is loading when a source is set but not yet decoded', () => {
    expect(resolveImageSceneState({ hasSrc: true, complete: false, naturalWidth: 0 })).toBe('loading')
  })

  it('is loading when complete is true but no frame decoded yet (naturalWidth 0)', () => {
    expect(resolveImageSceneState({ hasSrc: true, complete: true, naturalWidth: 0 })).toBe('loading')
  })
})
