import type { WorkItemRunRecord } from '@proj-airi/stage-projects'

/**
 * Stable failure category used by the project runner.
 */
export type ProjectRunnerFailureKind
  = | 'agent_error'
    | 'forbidden_path'
    | 'integration_failed'
    | 'missing_acceptance_evidence'
    | 'no_changes'
    | 'review_rejected'
    | 'validation_failed'
    | 'worker_blocked'

/**
 * Classified failure details for status comments, run records, and evals.
 */
export interface ProjectRunnerFailureClassification {
  /** Machine-readable failure category. */
  kind: ProjectRunnerFailureKind
  /** Human-readable summary extracted from the available signal. */
  summary: string
}

/**
 * Classifies project-runner failures from reviewer, worker, validation, and integration signals.
 *
 * Use when:
 * - A blocked run needs a stable category for chat and future retries
 * - Eval cases need deterministic failure buckets
 *
 * Expects:
 * - Inputs are compact summaries, not raw full logs
 *
 * Returns:
 * - A stable failure kind and summary, or undefined when no failure signal is present
 */
export function classifyProjectRunnerFailure(params: {
  blockedReason?: string
  changedFiles?: string[]
  error?: string
  reviewComment?: string
  runStatus?: WorkItemRunRecord['status']
  testSummary?: string
}): ProjectRunnerFailureClassification | undefined {
  const combined = [
    params.blockedReason,
    params.error,
    params.reviewComment,
    params.testSummary,
  ].filter(Boolean).join('\n')

  if (params.blockedReason) {
    return {
      kind: 'worker_blocked',
      summary: params.blockedReason,
    }
  }

  if (/forbidden paths?|project policy/i.test(combined)) {
    return {
      kind: 'forbidden_path',
      summary: firstUsefulLine(combined),
    }
  }

  if (/missing acceptance evidence/i.test(combined)) {
    return {
      kind: 'missing_acceptance_evidence',
      summary: firstUsefulLine(combined),
    }
  }

  if (/exit code:\s*(?!0\b)\d+|timed out:\s*true|validation failed/i.test(combined)) {
    return {
      kind: 'validation_failed',
      summary: firstUsefulLine(combined),
    }
  }

  if (/conflict|could not apply|cherry-pick|integration/i.test(combined)) {
    return {
      kind: 'integration_failed',
      summary: firstUsefulLine(combined),
    }
  }

  if ((params.changedFiles ?? []).length === 0 && params.runStatus === 'blocked') {
    return {
      kind: 'no_changes',
      summary: 'Worker finished without changing any files.',
    }
  }

  if (params.runStatus === 'blocked' && combined.trim()) {
    return {
      kind: 'review_rejected',
      summary: firstUsefulLine(combined),
    }
  }

  if (params.error) {
    return {
      kind: 'agent_error',
      summary: firstUsefulLine(params.error),
    }
  }

  return undefined
}

function firstUsefulLine(value: string): string {
  return value.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? 'Project runner failed.'
}
