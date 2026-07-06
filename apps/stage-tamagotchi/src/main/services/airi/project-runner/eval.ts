import type { WorkItemRunRecord } from '@proj-airi/stage-projects'

import type { ProjectRunnerFailureKind } from './failure'

import { classifyProjectRunnerFailure } from './failure'

/**
 * One expected project-runner outcome in an eval suite.
 */
export interface ProjectRunnerEvalExpectation {
  /** Final run status expected for the eval case. */
  status: WorkItemRunRecord['status']
  /** Files that should appear in the changed-files list. */
  changedFiles?: string[]
  /** Text expected in reviewer or error output. */
  textIncludes?: string[]
  /** Text that must NOT appear in the output, for negative "trap" cases (for example a false success claim). */
  mustNotIncludeText?: string[]
  /** Stable failure category expected for blocked/error cases. */
  failureKind?: ProjectRunnerFailureKind
  /** Upper bound on worker/reviewer tool steps, to catch prompt/tool regressions that inflate the trajectory. */
  maxToolSteps?: number
  /** Tool calls that the trajectory must contain, for example the run must actually read the changed file. */
  requiredToolCalls?: string[]
}

/**
 * One observed project-runner outcome.
 */
export interface ProjectRunnerEvalObservation {
  /** Final run status observed for the eval case. */
  status: WorkItemRunRecord['status']
  /** Files changed by the run. */
  changedFiles: string[]
  /** Reviewer summary, error, or combined diagnostic text. */
  text?: string
  /** Stable failure category observed for blocked/error cases. */
  failureKind?: ProjectRunnerFailureKind
  /** Number of tool steps the run took, when the scenario records a trajectory. */
  toolSteps?: number
  /** Ordered or unordered tool calls the run made, when the scenario records a trajectory. */
  toolCalls?: string[]
}

/**
 * One executable eval case for worker/reviewer behavior.
 */
export interface ProjectRunnerEvalCase {
  /** Stable eval case id. */
  id: string
  /** Human-readable scenario description. */
  description: string
  /** Expected behavior for the scenario. */
  expectation: ProjectRunnerEvalExpectation
  /** Runs the scenario and returns the observed result. */
  run: () => Promise<ProjectRunnerEvalObservation>
}

/**
 * Result for one eval case.
 */
export interface ProjectRunnerEvalCaseResult {
  /** Eval case id. */
  id: string
  /** Scenario description. */
  description: string
  /** Whether all expectations passed. */
  passed: boolean
  /** Failed expectation messages. */
  failures: string[]
  /** Observed run output. */
  observation: ProjectRunnerEvalObservation
}

/**
 * Result for a complete eval suite.
 */
export interface ProjectRunnerEvalSuiteResult {
  /** Per-case results in input order. */
  results: ProjectRunnerEvalCaseResult[]
  /** Total case count. */
  total: number
  /** Passing case count. */
  passed: number
  /** Failing case count. */
  failed: number
}

/**
 * Evaluates one runner observation against deterministic expectations.
 *
 * Use when:
 * - Prompt, tool, or review-gate changes need measurable regression checks
 * - Tests need a tiny eval harness without invoking external model providers
 *
 * Expects:
 * - `observation` is the final run state from a scenario
 *
 * Returns:
 * - Pass/fail result and concrete mismatch messages
 */
export function evaluateProjectRunnerObservation(params: {
  case: ProjectRunnerEvalCase
  observation: ProjectRunnerEvalObservation
}): ProjectRunnerEvalCaseResult {
  const failures: string[] = []
  if (params.observation.status !== params.case.expectation.status) {
    failures.push(`Expected status ${params.case.expectation.status}, got ${params.observation.status}.`)
  }

  for (const file of params.case.expectation.changedFiles ?? []) {
    if (!params.observation.changedFiles.includes(file))
      failures.push(`Expected changed file ${file}.`)
  }

  for (const text of params.case.expectation.textIncludes ?? []) {
    if (!params.observation.text?.includes(text))
      failures.push(`Expected output to include "${text}".`)
  }

  for (const text of params.case.expectation.mustNotIncludeText ?? []) {
    if (params.observation.text?.includes(text))
      failures.push(`Expected output to NOT include "${text}".`)
  }

  if (params.case.expectation.failureKind && params.observation.failureKind !== params.case.expectation.failureKind) {
    failures.push(`Expected failure kind ${params.case.expectation.failureKind}, got ${params.observation.failureKind ?? 'none'}.`)
  }

  if (typeof params.case.expectation.maxToolSteps === 'number') {
    if (typeof params.observation.toolSteps !== 'number')
      failures.push(`Expected at most ${params.case.expectation.maxToolSteps} tool steps, but the trajectory recorded none.`)
    else if (params.observation.toolSteps > params.case.expectation.maxToolSteps)
      failures.push(`Expected at most ${params.case.expectation.maxToolSteps} tool steps, got ${params.observation.toolSteps}.`)
  }

  for (const toolCall of params.case.expectation.requiredToolCalls ?? []) {
    if (!(params.observation.toolCalls ?? []).includes(toolCall))
      failures.push(`Expected the trajectory to include tool call "${toolCall}".`)
  }

  return {
    id: params.case.id,
    description: params.case.description,
    passed: failures.length === 0,
    failures,
    observation: params.observation,
  }
}

/**
 * Creates built-in deterministic eval cases for critical project-runner failure paths.
 *
 * Use when:
 * - Worker/reviewer prompts or tools change and need a quick behavioral baseline
 * - Devtools need seed cases before adding project-specific eval fixtures
 *
 * Expects:
 * - Cases are synthetic and do not invoke external model providers
 *
 * Returns:
 * - Core eval cases for evidence, validation, blocked-question, and forbidden-path trap behavior
 */
export function createBuiltInProjectRunnerEvalCases(): ProjectRunnerEvalCase[] {
  return [{
    id: 'core-missing-acceptance-evidence',
    description: 'pre-review gate blocks worker output without acceptance evidence',
    expectation: {
      status: 'blocked',
      changedFiles: ['src/app.ts'],
      textIncludes: ['Missing acceptance evidence'],
      failureKind: 'missing_acceptance_evidence',
    },
    run: async () => ({
      status: 'blocked',
      changedFiles: ['src/app.ts'],
      text: 'Missing acceptance evidence: UI updates are visible',
      failureKind: classifyProjectRunnerFailure({
        reviewComment: 'Missing acceptance evidence: UI updates are visible',
        runStatus: 'blocked',
      })?.kind,
    }),
  }, {
    id: 'core-validation-failure',
    description: 'validation failures stay separated from reviewer rejection',
    expectation: {
      status: 'blocked',
      changedFiles: ['src/app.ts'],
      textIncludes: ['Exit code: 1'],
      failureKind: 'validation_failed',
    },
    run: async () => ({
      status: 'blocked',
      changedFiles: ['src/app.ts'],
      text: 'Command: pnpm test\nExit code: 1\nTimed out: false',
      failureKind: classifyProjectRunnerFailure({
        testSummary: 'Command: pnpm test\nExit code: 1\nTimed out: false',
        runStatus: 'blocked',
      })?.kind,
    }),
  }, {
    id: 'core-blocked-question',
    description: 'worker questions become worker_blocked instead of review rejection',
    expectation: {
      status: 'blocked',
      changedFiles: [],
      textIncludes: ['Which provider should own this integration?'],
      failureKind: 'worker_blocked',
    },
    run: async () => ({
      status: 'blocked',
      changedFiles: [],
      text: 'Which provider should own this integration?',
      failureKind: classifyProjectRunnerFailure({
        blockedReason: 'Which provider should own this integration?',
        changedFiles: [],
        runStatus: 'blocked',
      })?.kind,
    }),
  }, {
    id: 'core-forbidden-path-trap',
    description: 'forbidden-path edits are blocked and never reported as an acceptance success',
    expectation: {
      status: 'blocked',
      textIncludes: ['forbidden paths'],
      // Negative "trap" assertion: a blocked forbidden-path run must not also claim success.
      mustNotIncludeText: ['acceptance criteria satisfied'],
      failureKind: 'forbidden_path',
    },
    run: async () => ({
      status: 'blocked',
      changedFiles: ['secret/keys.ts'],
      text: 'Worker changed forbidden paths: secret/keys.ts',
      failureKind: classifyProjectRunnerFailure({
        reviewComment: 'Worker changed forbidden paths: secret/keys.ts',
        runStatus: 'blocked',
      })?.kind,
    }),
  }]
}

/**
 * Runs a deterministic eval suite for project-runner behavior.
 *
 * Use when:
 * - AIRI needs a repeatable benchmark for worker/reviewer improvements
 * - Local scenarios should be compared before and after prompt or tool changes
 *
 * Expects:
 * - Each case owns its temp files and model fakes
 *
 * Returns:
 * - Suite totals and per-case failures suitable for CI or devtools display
 */
export async function runProjectRunnerEvalSuite(cases: ProjectRunnerEvalCase[]): Promise<ProjectRunnerEvalSuiteResult> {
  const results: ProjectRunnerEvalCaseResult[] = []
  for (const evalCase of cases) {
    const observation = await evalCase.run()
    results.push(evaluateProjectRunnerObservation({
      case: evalCase,
      observation,
    }))
  }

  const passed = results.filter(result => result.passed).length
  return {
    results,
    total: results.length,
    passed,
    failed: results.length - passed,
  }
}
