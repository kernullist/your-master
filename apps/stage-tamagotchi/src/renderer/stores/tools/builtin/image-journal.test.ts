import type { ResolvedArtistryConfig } from '@proj-airi/stage-ui/stores/modules/artistry'

import { resolveArtistryConfigFromStore } from '@proj-airi/stage-ui/stores/modules/artistry'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isArtistryBackendReachable, resetArtistryBackendProbeCache } from './image-journal'

function comfyConfig(serverUrl: string | undefined): ResolvedArtistryConfig {
  return {
    provider: 'comfyui',
    model: 'flux',
    promptPrefix: '',
    options: {},
    globals: { comfyuiServerUrl: serverUrl },
  } as ResolvedArtistryConfig
}

// ROOT CAUSE:
//
// The artistry toolset always advertised `image_journal` to the LLM even when
// the configured ComfyUI server was offline. Reasoning/agentic models then
// happily called the tool, the headless generation stalled or failed, and the
// whole chat turn dragged with no visible reply.
//
// We fixed this by probing the backend (cached, short timeout) and excluding
// the tool from the toolset for the turn when the probe fails.
describe('isArtistryBackendReachable', () => {
  beforeEach(() => {
    resetArtistryBackendProbeCache()
  })

  it('treats non-comfyui providers as reachable without probing', async () => {
    const fetchImpl = vi.fn()
    const config = { ...comfyConfig('http://localhost:8188'), provider: 'replicate' } as ResolvedArtistryConfig
    const reachable = await isArtistryBackendReachable(config, { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(reachable).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports unreachable when no comfyui server url is configured', async () => {
    const fetchImpl = vi.fn()
    const reachable = await isArtistryBackendReachable(comfyConfig(''), { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(reachable).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports reachable when the probe fetch resolves', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true })
    const reachable = await isArtistryBackendReachable(comfyConfig('http://localhost:8188'), { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(reachable).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const probedUrl = fetchImpl.mock.calls[0][0] as URL
    expect(String(probedUrl)).toBe('http://localhost:8188/system_stats')
  })

  it('reports unreachable when the probe fetch rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const reachable = await isArtistryBackendReachable(comfyConfig('http://localhost:8188'), { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(reachable).toBe(false)
  })

  it('caches the probe result within the TTL and re-probes after it expires', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    let clock = 1_000_000
    const now = () => clock

    const first = await isArtistryBackendReachable(comfyConfig('http://localhost:8188'), { fetchImpl: fetchImpl as unknown as typeof fetch, now })
    expect(first).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Within TTL: cached, no second probe even though the result is negative.
    clock += 10_000
    const second = await isArtistryBackendReachable(comfyConfig('http://localhost:8188'), { fetchImpl: fetchImpl as unknown as typeof fetch, now })
    expect(second).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Past TTL: re-probes and picks up a recovered backend.
    clock += 31_000
    fetchImpl.mockResolvedValue({ ok: true })
    const third = await isArtistryBackendReachable(comfyConfig('http://localhost:8188'), { fetchImpl: fetchImpl as unknown as typeof fetch, now })
    expect(third).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('image_journal config snapshot', () => {
  it('extracts plain values instead of leaking Ref objects', () => {
    const config = resolveArtistryConfigFromStore({
      activeProvider: { value: 'comfyui' },
      activeModel: { value: 'flux' },
      defaultPromptPrefix: { value: 'anime style' },
      providerOptions: { value: { seed: 42 } },
      comfyuiServerUrl: { value: 'http://localhost:8188' },
      comfyuiSavedWorkflows: { value: [{ id: 'wf-1' }] },
      comfyuiActiveWorkflow: { value: 'wf-1' },
      replicateApiKey: { value: 'r8_xxx' },
      replicateDefaultModel: { value: 'black-forest-labs/flux-schnell' },
      replicateAspectRatio: { value: '16:9' },
      replicateInferenceSteps: { value: 4 },
      nanobananaApiKey: { value: 'AIza-test' },
      nanobananaModel: { value: 'gemini-3.1-flash-image-preview' },
      nanobananaResolution: { value: '1K' },
    })

    expect(config).toEqual({
      provider: 'comfyui',
      model: 'flux',
      promptPrefix: 'anime style',
      options: { seed: 42 },
      globals: {
        comfyuiServerUrl: 'http://localhost:8188',
        comfyuiSavedWorkflows: [{ id: 'wf-1' }],
        comfyuiActiveWorkflow: 'wf-1',
        replicateApiKey: 'r8_xxx',
        replicateDefaultModel: 'black-forest-labs/flux-schnell',
        replicateAspectRatio: '16:9',
        replicateInferenceSteps: 4,
        nanobananaApiKey: 'AIza-test',
        nanobananaModel: 'gemini-3.1-flash-image-preview',
        nanobananaResolution: '1K',
      },
    })
  })
})
