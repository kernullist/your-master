import { describe, expect, it } from 'vitest'

import { shouldReuseStageObjectUrl } from './stage-model'

// ROOT CAUSE:
//
// For file-backed display models, updateStageModel() minted a fresh blob: URL
// via URL.createObjectURL on every run. replaceStageModelUrl dedupes by URL
// equality, but a freshly minted object URL is always a new unique string, so
// the guard never helped for file models: re-resolving the same model changed
// stageModelSelectedUrl, forcing the renderer to reload and flashing the
// "Loading..." overlay.
//
// We fixed this by caching the object URL per model id and reusing it while the
// same model is still active (its URL still assigned to the stage). This guard
// decides reuse.
describe('shouldReuseStageObjectUrl', () => {
  it('reuses when the same model is active and its url is still assigned', () => {
    expect(shouldReuseStageObjectUrl({ modelId: 'm1', url: 'blob:a' }, 'm1', 'blob:a')).toBe(true)
  })

  it('does not reuse when no cache exists yet', () => {
    expect(shouldReuseStageObjectUrl(undefined, 'm1', 'blob:a')).toBe(false)
  })

  it('does not reuse for a different model id', () => {
    expect(shouldReuseStageObjectUrl({ modelId: 'm1', url: 'blob:a' }, 'm2', 'blob:a')).toBe(false)
  })

  it('does not reuse once the stage switched away (cached url no longer assigned, likely revoked)', () => {
    expect(shouldReuseStageObjectUrl({ modelId: 'm1', url: 'blob:a' }, 'm1', 'blob:b')).toBe(false)
  })

  it('does not reuse when the stage currently has no url', () => {
    expect(shouldReuseStageObjectUrl({ modelId: 'm1', url: 'blob:a' }, 'm1', undefined)).toBe(false)
  })
})
