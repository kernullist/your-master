import { describe, expect, it } from 'vitest'

import { composeCardSystemPrompt } from './airi-card'

// ROOT CAUSE:
//
// The card `name` field was UI-only: the composed system prompt joined only
// systemPrompt/description/personality, so typing a character name in the
// card editor never reached the model and the character answered "I don't
// know" when asked for its name.
//
// We fixed this by prepending an identity line when the card has a name and
// no prompt-bearing field already declares one in prose.
describe('composeCardSystemPrompt', () => {
  it('prepends an identity line when the card has a name and the prompt does not declare one', () => {
    const prompt = composeCardSystemPrompt({
      name: '시로하',
      systemPrompt: 'You are a cheerful companion.',
      personality: 'gentle and curious',
    })

    expect(prompt.startsWith('Your name is "시로하".')).toBe(true)
    expect(prompt).toContain('When asked for your name, answer "시로하".')
    expect(prompt).toContain('You are a cheerful companion.')
    expect(prompt).toContain('gentle and curious')
  })

  it('does not inject a name line when the prompt already declares a name in prose', () => {
    const prompt = composeCardSystemPrompt({
      name: 'ReLU',
      description: 'Good morning! Your name is AIRI, pronounced as /aɪriː/.',
    })

    expect(prompt).not.toContain('Your name is "ReLU"')
    expect(prompt).toContain('Your name is AIRI')
  })

  it('does not inject anything for blank names', () => {
    const prompt = composeCardSystemPrompt({
      name: '   ',
      systemPrompt: 'base prompt',
    })

    expect(prompt).toBe('base prompt')
  })

  it('joins prompt-bearing fields in order and skips empty ones', () => {
    const prompt = composeCardSystemPrompt({
      systemPrompt: 'A',
      description: '',
      personality: 'B',
      extensions: { airi: { modules: { artistry: { widgetInstruction: 'C' } } } },
    })

    expect(prompt).toBe('A\n\nB\n\nC')
  })
})
