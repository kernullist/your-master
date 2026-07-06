import { describe, expect, it } from 'vitest'

import {
  createBuiltInProjectRunnerEvalCases,
  evaluateProjectRunnerObservation,
  runProjectRunnerEvalSuite,
} from './eval'

describe('project runner eval harness', () => {
  it('scores deterministic project runner observations', async () => {
    const result = evaluateProjectRunnerObservation({
      case: {
        id: 'eval-1',
        description: 'worker changes expected file',
        expectation: {
          status: 'done',
          changedFiles: ['src/app.ts'],
          textIncludes: ['Looks good'],
        },
        run: async () => ({
          status: 'done',
          changedFiles: ['src/app.ts'],
          text: 'Looks good',
        }),
      },
      observation: {
        status: 'done',
        changedFiles: ['src/app.ts'],
        text: 'Looks good',
      },
    })

    expect(result.passed).toBe(true)
    expect(result.failures).toEqual([])
  })

  it('runs eval suites and reports failures', async () => {
    const suite = await runProjectRunnerEvalSuite([{
      id: 'eval-pass',
      description: 'passes',
      expectation: {
        status: 'done',
      },
      run: async () => ({
        status: 'done',
        changedFiles: [],
      }),
    }, {
      id: 'eval-fail',
      description: 'fails',
      expectation: {
        status: 'done',
        changedFiles: ['src/app.ts'],
      },
      run: async () => ({
        status: 'blocked',
        changedFiles: [],
      }),
    }])

    expect(suite.total).toBe(2)
    expect(suite.passed).toBe(1)
    expect(suite.failed).toBe(1)
    expect(suite.results[1]?.failures).toEqual([
      'Expected status done, got blocked.',
      'Expected changed file src/app.ts.',
    ])
  })

  it('checks trajectory budgets, required tool calls, and negative traps', () => {
    const result = evaluateProjectRunnerObservation({
      case: {
        id: 'eval-trajectory',
        description: 'reviewer stays in budget, inspects the changed file, and never falsely claims success',
        expectation: {
          status: 'blocked',
          maxToolSteps: 5,
          requiredToolCalls: ['read'],
          mustNotIncludeText: ['acceptance criteria satisfied'],
        },
        run: async () => ({
          status: 'blocked',
          changedFiles: ['src/app.ts'],
        }),
      },
      observation: {
        status: 'blocked',
        changedFiles: ['src/app.ts'],
        text: 'Rejected: missing guard',
        toolSteps: 8,
        toolCalls: ['list', 'diff'],
      },
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain('Expected at most 5 tool steps, got 8.')
    expect(result.failures).toContain('Expected the trajectory to include tool call "read".')
    // The negative trap passes here because the output does not contain the forbidden text.
    expect(result.failures).not.toContain('Expected output to NOT include "acceptance criteria satisfied".')
  })

  it('fails a negative trap when the output contains forbidden text', () => {
    const result = evaluateProjectRunnerObservation({
      case: {
        id: 'eval-trap',
        description: 'a blocked run must not also claim success',
        expectation: {
          status: 'blocked',
          mustNotIncludeText: ['acceptance criteria satisfied'],
        },
        run: async () => ({ status: 'blocked', changedFiles: [] }),
      },
      observation: {
        status: 'blocked',
        changedFiles: [],
        text: 'Blocked, but acceptance criteria satisfied anyway',
      },
    })

    expect(result.passed).toBe(false)
    expect(result.failures).toContain('Expected output to NOT include "acceptance criteria satisfied".')
  })

  it('runs built-in regression eval cases for core failure paths', async () => {
    const suite = await runProjectRunnerEvalSuite(createBuiltInProjectRunnerEvalCases())

    expect(suite.total).toBe(4)
    expect(suite.failed).toBe(0)
    expect(suite.results.map(result => result.id)).toEqual([
      'core-missing-acceptance-evidence',
      'core-validation-failure',
      'core-blocked-question',
      'core-forbidden-path-trap',
    ])
  })
})
