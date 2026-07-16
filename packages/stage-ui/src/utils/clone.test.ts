import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'

import { cloneDeepSafe } from './clone'

describe('cloneDeepSafe', () => {
  it('deep-clones plain structured data and detaches references', () => {
    const source = {
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
      ],
    }

    const cloned = cloneDeepSafe(source)

    expect(cloned).toEqual(source)
    expect(cloned).not.toBe(source)
    expect(cloned.content[1]).not.toBe(source.content[1])
  })

  // ROOT CAUSE:
  //
  // structuredClone rejects Proxy objects with DataCloneError
  // ("#<Object> could not be cloned" in Chromium). Vue's deep reactivity
  // wraps nested objects in Proxies on read, so snapshotting store state
  // with bare structuredClone crashed the chat turn when an image
  // attachment (array content) leaked a reactive part into the composed
  // message. cloneDeepSafe falls back to JSON round-tripping, which reads
  // through Proxies transparently.
  it('clones values containing nested Vue reactive proxies', () => {
    const reactiveParts = reactive([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ])
    // Plain outer object holding reactive proxies inside — the exact shape
    // that used to reach structuredClone via composed chat messages.
    const source = { role: 'user', content: reactiveParts.map(part => part) }

    expect(() => structuredClone(source)).toThrow()

    const cloned = cloneDeepSafe(source)

    expect(cloned).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
      ],
    })
    expect(() => structuredClone(cloned)).not.toThrow()
  })

  it('unwraps a top-level reactive proxy without the JSON fallback losing types', () => {
    const source = reactive({ createdAt: 123, tags: ['a', 'b'] })

    const cloned = cloneDeepSafe(source)

    expect(cloned).toEqual({ createdAt: 123, tags: ['a', 'b'] })
    expect(() => structuredClone(cloned)).not.toThrow()
  })
})
