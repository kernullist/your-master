import type { Project, ProjectAgentSettings, WorkItem } from '@proj-airi/stage-projects'

import type { ProjectRunnerFailureKind } from './failure'
import type { ProjectValidationCommandResult } from './tests'

import { classifyProjectRunnerFailure } from './failure'

/**
 * Subtask progress reported by the worker while executing a manager brief.
 */
export interface ProjectSubtaskProgress {
  /** Manager-provided or worker-created subtask title. */
  title: string
  /** Current subtask state. */
  status: 'blocked' | 'done' | 'in_progress' | 'todo'
  /** Evidence, blocker detail, or implementation note for this subtask. */
  evidence?: string
}

/**
 * Input sent to the worker agent for one attempt.
 */
export interface WorkerAgentInput {
  /** Project being modified. */
  project: Project
  /** Work item being implemented. */
  workItem: WorkItem
  /** Zero-based attempt index. */
  attempt: number
  /** Reviewer comment from the previous failed attempt. */
  previousReviewerComment?: string
  /** Structured reviewer feedback from the previous failed attempt. */
  previousReviewerFeedback?: string
  /** Diff summary from the previous worker attempt. */
  previousDiffSummary?: string
  /** Earlier failure notes collected before this run. */
  failureMemory?: string[]
}

/**
 * Output produced by the worker agent after editing files.
 */
export interface WorkerAgentResult {
  /** Files changed by this worker attempt. */
  changedFiles: string[]
  /** Worker-provided evidence for each acceptance criterion. */
  acceptanceEvidence?: Array<{
    /** Acceptance criterion text. */
    criterion: string
    /** Evidence from files, diffs, tests, or reasoned non-applicability. */
    evidence: string
    /** Worker status for this criterion. */
    status: 'missing' | 'not_applicable' | 'satisfied'
  }>
  /** Compact diff summary. */
  diffSummary: string
  /** Short worker note. */
  comment: string
  /** Optional test result summary. */
  testSummary?: string
  /**
   * Structured results of the harness-executed final validation.
   *
   * These carry the real exit codes so the pre-review gate and reviewer can trust execution
   * results instead of re-parsing {@link WorkerAgentResult.testSummary} text.
   */
  validationResults?: ProjectValidationCommandResult[]
  /** Worker-reported subtask execution progress. */
  subtaskProgress?: ProjectSubtaskProgress[]
  /** Optional reason when the worker cannot continue without user/project input. */
  blockedReason?: string
  /** Questions the user needs to answer before the work can continue. */
  blockedQuestions?: string[]
  /** Stable failure category when the worker blocks. */
  failureKind?: ProjectRunnerFailureKind
}

/**
 * Input sent to the reviewer agent.
 */
export interface ReviewerAgentInput {
  /** Project being reviewed. */
  project: Project
  /** Work item being reviewed. */
  workItem: WorkItem
  /** Zero-based attempt index. */
  attempt: number
  /** Worker output for this attempt. */
  workerResult: WorkerAgentResult
}

/**
 * Reviewer decision for one attempt.
 */
export interface ReviewerAgentResult {
  /** True when requirements are satisfied and no blocking bug risk remains. */
  passed: boolean
  /** Reviewer feedback shown in work item comments. */
  comment: string
  /** Blocking or non-blocking issues found by the reviewer. */
  findings?: Array<{
    /** Reviewer severity label. */
    severity: 'blocker' | 'major' | 'minor' | 'nit'
    /** Optional project-relative file path. */
    file?: string
    /** Optional one-based line number. */
    line?: number
    /** Issue summary. */
    message: string
    /** Change needed before approval, when applicable. */
    requiredChange?: string
  }>
  /** Explicit required changes sent back to the worker. */
  requiredChanges?: string[]
  /** Extra validation commands or checks the reviewer wants. */
  suggestedTests?: string[]
  /** Reviewer evidence for each acceptance criterion. */
  acceptanceEvidence?: Array<{
    /** Acceptance criterion text. */
    criterion: string
    /** Evidence from files, diffs, tests, or reasoned non-applicability. */
    evidence: string
    /** Reviewer status for this criterion. */
    status: 'missing' | 'not_applicable' | 'satisfied'
  }>
  /** Reviewer confidence in the decision, from 0 to 1. */
  confidence?: number
  /** Stable failure category when review rejects or a gate blocks. */
  failureKind?: ProjectRunnerFailureKind
}

/**
 * Hooks used by the review loop to update persistence and execute agents.
 */
export interface ProjectReviewLoopOptions {
  /** Project context. */
  project: Project
  /** Work item context. */
  workItem: WorkItem
  /** Global AIRI project settings. */
  settings: Pick<ProjectAgentSettings, 'maxReviewRetries'>
  /** Earlier failure notes collected before this run. */
  failureMemory?: string[]
  /** Runs the coding agent for one attempt. */
  runWorker: (input: WorkerAgentInput) => Promise<WorkerAgentResult>
  /** Runs the reviewer agent for one attempt. */
  runReviewer: (input: ReviewerAgentInput) => Promise<ReviewerAgentResult>
  /** Persists status changes. */
  updateStatus: (status: WorkItem['status']) => Promise<void>
  /** Persists compact comments. */
  addComment: (actor: 'worker' | 'reviewer' | 'system', kind: 'worker' | 'review' | 'status' | 'diff' | 'test', content: string) => Promise<void>
  /** Reverts changed files when all review attempts fail. */
  revertChanges: (changedFiles: string[]) => Promise<void>
}

/**
 * Final result of the worker/reviewer loop.
 */
export interface ProjectReviewLoopResult {
  /** Whether the reviewer accepted the result. */
  passed: boolean
  /** Number of worker attempts executed. */
  attempts: number
  /** Unique files changed by worker attempts. */
  changedFiles: string[]
  /** Latest worker subtask progress, including blocked subtasks. */
  subtaskProgress?: ProjectSubtaskProgress[]
  /** Last reviewer comment. */
  reviewerComment?: string
  /** Reason the worker stopped before review, when it needed outside input. */
  blockedReason?: string
  /** Stable failure category for blocked results. */
  failureKind?: ProjectRunnerFailureKind
}

function formatReviewerFeedback(review: ReviewerAgentResult): string {
  return [
    review.comment,
    review.failureKind ? `Failure kind: ${review.failureKind}` : '',
    review.requiredChanges?.length ? `Required changes:\n${review.requiredChanges.map(item => `- ${item}`).join('\n')}` : '',
    review.findings?.length
      ? `Findings:\n${review.findings.map((finding) => {
        const location = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ''})` : ''
        return `- [${finding.severity}]${location} ${finding.message}${finding.requiredChange ? ` -> ${finding.requiredChange}` : ''}`
      }).join('\n')}`
      : '',
    review.suggestedTests?.length ? `Suggested tests:\n${review.suggestedTests.map(item => `- ${item}`).join('\n')}` : '',
    review.acceptanceEvidence?.length
      ? `Acceptance evidence:\n${review.acceptanceEvidence.map(item => `- [${item.status}] ${item.criterion}: ${item.evidence}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n')
}

function formatReviewerComment(review: ReviewerAgentResult): string {
  const details = formatReviewerFeedback(review)
  const confidence = typeof review.confidence === 'number'
    ? `\n신뢰도: ${Math.round(review.confidence * 100)}%`
    : ''
  return `리뷰 결과: ${details}${confidence}`.trim()
}

function formatSubtaskProgress(progress: ProjectSubtaskProgress[]): string {
  return `서브태스크 진행상황:\n${progress.map(item => `- [${item.status}] ${item.title}${item.evidence ? `: ${item.evidence}` : ''}`).join('\n')}`
}

/**
 * Runs the worker/reviewer retry loop for one work item.
 *
 * Use when:
 * - AIRI starts implementation for a local project work item
 * - Reviewer failures should automatically return to the worker up to the configured limit
 *
 * Expects:
 * - Dirty worktree confirmation has already happened before the first attempt
 *
 * Returns:
 * - Final pass/block decision and changed file list
 *
 * Call stack:
 *
 * project runner
 *   -> {@link runProjectReviewLoop}
 *     -> worker agent
 *     -> reviewer agent
 *     -> optional revert callback
 */
export async function runProjectReviewLoop(options: ProjectReviewLoopOptions): Promise<ProjectReviewLoopResult> {
  const changedFiles = new Set<string>()
  let previousReviewerComment: string | undefined
  let previousReviewerFeedback: string | undefined
  let previousDiffSummary: string | undefined
  let previousFailureKind: ProjectRunnerFailureKind | undefined
  let latestSubtaskProgress: ProjectSubtaskProgress[] | undefined
  // Convergence detection: identical (failureKind, diff) across consecutive attempts means no progress.
  let previousStallSignature: string | undefined
  let completedAttempts = 0
  let stalled = false

  for (let attempt = 0; attempt < options.settings.maxReviewRetries; attempt += 1) {
    const attemptLabel = `${attempt + 1}/${options.settings.maxReviewRetries}`
    completedAttempts = attempt + 1
    await options.updateStatus('in_progress')
    await options.addComment(
      'worker',
      'worker',
      `워커 에이전트가 ${options.workItem.identifier} 일감을 확인하고 착수했어. (시도 ${attemptLabel})`,
    )
    const workerResult = await options.runWorker({
      project: options.project,
      workItem: options.workItem,
      attempt,
      previousReviewerComment,
      previousReviewerFeedback,
      previousDiffSummary,
      failureMemory: options.failureMemory,
    })

    for (const file of workerResult.changedFiles) {
      changedFiles.add(file)
    }
    previousDiffSummary = workerResult.diffSummary
    latestSubtaskProgress = workerResult.subtaskProgress
    await options.addComment('worker', 'worker', workerResult.comment)
    if (workerResult.subtaskProgress?.length)
      await options.addComment('worker', 'status', formatSubtaskProgress(workerResult.subtaskProgress))
    await options.addComment('worker', 'diff', workerResult.diffSummary)
    if (workerResult.testSummary)
      await options.addComment('system', 'test', workerResult.testSummary)
    if (workerResult.blockedReason) {
      const classification = classifyProjectRunnerFailure({
        blockedReason: workerResult.blockedReason,
        changedFiles: workerResult.changedFiles,
      })
      const questions = workerResult.blockedQuestions?.length
        ? `\n확인할 질문:\n${workerResult.blockedQuestions.map(question => `- ${question}`).join('\n')}`
        : ''
      await options.addComment(
        'system',
        'status',
        `워커가 사용자 확인이 필요해서 멈췄어.\n분류: ${workerResult.failureKind ?? classification?.kind ?? 'worker_blocked'}\n사유: ${workerResult.blockedReason}${questions}`,
      )
      await options.updateStatus('blocked')
      return {
        passed: false,
        attempts: attempt + 1,
        changedFiles: [...changedFiles],
        subtaskProgress: latestSubtaskProgress,
        blockedReason: workerResult.blockedReason,
        failureKind: workerResult.failureKind ?? classification?.kind ?? 'worker_blocked',
        reviewerComment: previousReviewerComment,
      }
    }
    await options.addComment(
      'worker',
      'worker',
      `워커 에이전트가 개발을 마치고 리뷰를 요청했어. (시도 ${attemptLabel})`,
    )

    await options.updateStatus('in_review')
    await options.addComment(
      'reviewer',
      'review',
      `리뷰어 에이전트가 ${options.workItem.identifier} 변경사항 리뷰를 시작했어. (시도 ${attemptLabel})`,
    )
    const review = await options.runReviewer({
      project: options.project,
      workItem: options.workItem,
      attempt,
      workerResult,
    })
    previousReviewerComment = review.comment
    previousReviewerFeedback = formatReviewerFeedback(review)
    previousFailureKind = review.failureKind
    await options.addComment('reviewer', 'review', formatReviewerComment(review))

    if (review.passed) {
      await options.updateStatus('done')
      return {
        passed: true,
        attempts: attempt + 1,
        changedFiles: [...changedFiles],
        subtaskProgress: latestSubtaskProgress,
        reviewerComment: review.comment,
      }
    }

    // Stop early when a repair round reproduces the same failure with the same diff: repeated
    // self-correction plateaus, so spending the remaining retries only burns tokens.
    const stallSignature = `${review.failureKind ?? 'review_rejected'}::${workerResult.diffSummary}`
    if (stallSignature === previousStallSignature) {
      stalled = true
      break
    }
    previousStallSignature = stallSignature
  }

  await options.revertChanges([...changedFiles])
  await options.addComment(
    'system',
    'status',
    stalled
      ? `연속된 시도에서 동일한 실패와 동일한 diff가 반복돼서 더 진행하지 않고 변경을 되돌렸어. (시도 ${completedAttempts}/${options.settings.maxReviewRetries})`
      : 'Review failed after maximum retries. Agent changes were reverted.',
  )
  await options.updateStatus('blocked')
  const classification = classifyProjectRunnerFailure({
    changedFiles: [...changedFiles],
    reviewComment: previousReviewerComment,
    runStatus: 'blocked',
  })
  return {
    passed: false,
    attempts: completedAttempts,
    changedFiles: [...changedFiles],
    subtaskProgress: latestSubtaskProgress,
    reviewerComment: previousReviewerComment,
    failureKind: previousFailureKind ?? classification?.kind ?? 'review_rejected',
  }
}
