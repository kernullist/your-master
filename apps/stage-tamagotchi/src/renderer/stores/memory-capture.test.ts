import { describe, expect, it } from 'vitest'

import { buildExtractionMessages, MAX_EXTRACTED_PER_TURN, parseExtractedMemories } from './memory-capture'

describe('parseExtractedMemories', () => {
  it('parses a plain JSON array', () => {
    const out = parseExtractedMemories('[{"kind":"instruction","text":"Email the report on Mondays"}]')
    expect(out).toEqual([{ kind: 'instruction', text: 'Email the report on Mondays' }])
  })

  it('tolerates markdown fences and surrounding prose', () => {
    const out = parseExtractedMemories('Sure, here you go:\n```json\n[{"kind":"decision","text":"Use LM Studio"}]\n```\nDone.')
    expect(out).toEqual([{ kind: 'decision', text: 'Use LM Studio' }])
  })

  it('returns [] for an empty array or no array', () => {
    expect(parseExtractedMemories('[]')).toEqual([])
    expect(parseExtractedMemories('nothing durable here')).toEqual([])
    expect(parseExtractedMemories('')).toEqual([])
  })

  it('returns [] on invalid JSON rather than throwing', () => {
    expect(parseExtractedMemories('[{kind: instruction}]')).toEqual([])
  })

  it('coerces unknown kinds to fact and drops entries without text', () => {
    const out = parseExtractedMemories('[{"kind":"weird","text":"a fact"},{"kind":"event"},{"text":"  "}]')
    expect(out).toEqual([{ kind: 'fact', text: 'a fact' }])
  })

  it('caps the number of items per turn', () => {
    const many = Array.from({ length: MAX_EXTRACTED_PER_TURN + 3 }, (_, i) => ({ kind: 'fact', text: `f${i}` }))
    expect(parseExtractedMemories(JSON.stringify(many))).toHaveLength(MAX_EXTRACTED_PER_TURN)
  })

  it('trims and caps long text', () => {
    const long = 'x'.repeat(400)
    const [item] = parseExtractedMemories(JSON.stringify([{ kind: 'fact', text: `  ${long}  ` }]))
    expect(item.text.length).toBe(300)
  })
})

describe('buildExtractionMessages', () => {
  it('includes known memories and the turn, and instructs JSON-only output', () => {
    const [system, user] = buildExtractionMessages('Remind me to call mom', 'Sure!', ['The user likes tea'])
    expect(system.role).toBe('system')
    expect(system.content).toContain('JSON array')
    expect(user.content).toContain('The user likes tea')
    expect(user.content).toContain('User: Remind me to call mom')
    expect(user.content).toContain('Assistant: Sure!')
  })

  it('shows (none) when there are no known memories', () => {
    const [, user] = buildExtractionMessages('hi there friend', 'hello', [])
    expect(user.content).toContain('Already known:\n(none)')
  })
})
