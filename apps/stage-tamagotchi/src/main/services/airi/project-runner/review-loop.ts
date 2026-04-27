import type { Project, ProjectAgentSettings, WorkItem } from '@proj-airi/stage-projects'

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
  /** Diff summary from the previous worker attempt. */
  previousDiffSummary?: string
}

/**
 * Output produced by the worker agent after editing files.
 */
export interface WorkerAgentResult {
  /** Files changed by this worker attempt. */
  changedFiles: string[]
  /** Compact diff summary. */
  diffSummary: string
  /** Short worker note. */
  comment: string
  /** Optional test result summary. */
  testSummary?: string
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
  /** Last reviewer comment. */
  reviewerComment?: string
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
  let previousDiffSummary: string | undefined

  for (let attempt = 0; attempt < options.settings.maxReviewRetries; attempt += 1) {
    const attemptLabel = `${attempt + 1}/${options.settings.maxReviewRetries}`
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
      previousDiffSummary,
    })

    for (const file of workerResult.changedFiles) {
      changedFiles.add(file)
    }
    previousDiffSummary = workerResult.diffSummary
    await options.addComment('worker', 'worker', workerResult.comment)
    await options.addComment('worker', 'diff', workerResult.diffSummary)
    if (workerResult.testSummary)
      await options.addComment('system', 'test', workerResult.testSummary)
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
    await options.addComment('reviewer', 'review', `리뷰 결과: ${review.comment}`)

    if (review.passed) {
      await options.updateStatus('done')
      return {
        passed: true,
        attempts: attempt + 1,
        changedFiles: [...changedFiles],
        reviewerComment: review.comment,
      }
    }
  }

  await options.revertChanges([...changedFiles])
  await options.addComment('system', 'status', 'Review failed after maximum retries. Agent changes were reverted.')
  await options.updateStatus('blocked')
  return {
    passed: false,
    attempts: options.settings.maxReviewRetries,
    changedFiles: [...changedFiles],
    reviewerComment: previousReviewerComment,
  }
}
