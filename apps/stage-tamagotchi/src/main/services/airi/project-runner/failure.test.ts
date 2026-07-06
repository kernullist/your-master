import { describe, expect, it } from 'vitest'

import { classifyProjectRunnerFailure } from './failure'

describe('project runner failure classification', () => {
  it('classifies validation and blocked-question failures before generic review rejection', () => {
    expect(classifyProjectRunnerFailure({
      testSummary: 'Command: pnpm test\nExit code: 1\nTimed out: false',
      runStatus: 'blocked',
    })?.kind).toBe('validation_failed')

    expect(classifyProjectRunnerFailure({
      blockedReason: 'Which API key should be used?',
      runStatus: 'blocked',
    })?.kind).toBe('worker_blocked')
  })
})
