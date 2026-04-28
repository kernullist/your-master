import type { Project, WorkItem } from '@proj-airi/stage-projects'

import { describe, expect, it, vi } from 'vitest'

import { runProjectReviewLoop } from './review-loop'

const project: Project = {
  id: 'project-1',
  name: 'demo',
  issuePrefix: 'AIRI',
  rootPath: 'F:/workspace/demo',
  gitEnabled: true,
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
}

const workItem: WorkItem = {
  id: 'work-1',
  projectId: 'project-1',
  identifier: 'AIRI-12',
  title: 'Add board',
  goal: 'Show a board',
  acceptanceCriteria: ['Board is visible'],
  status: 'todo',
  position: 0,
  createdAt: 1,
  updatedAt: 1,
}

describe('project review loop', () => {
  it('returns to the worker with reviewer feedback until review passes', async () => {
    const statuses: WorkItem['status'][] = []
    const comments: Array<{ actor: 'worker' | 'reviewer' | 'system', kind: 'worker' | 'review' | 'status' | 'diff' | 'test', content: string }> = []
    const runWorker = vi.fn(async input => ({
      changedFiles: [`file-${input.attempt}.ts`],
      diffSummary: `diff ${input.attempt}`,
      comment: input.previousReviewerComment ?? 'initial',
    }))
    const runReviewer = vi.fn(async input => ({
      passed: input.attempt === 1,
      comment: input.attempt === 0 ? 'Please fix' : 'Looks good',
    }))

    const result = await runProjectReviewLoop({
      project,
      workItem,
      settings: { maxReviewRetries: 5 },
      runWorker,
      runReviewer,
      updateStatus: async (status) => {
        statuses.push(status)
      },
      addComment: async (actor, kind, content) => {
        comments.push({ actor, kind, content })
      },
      revertChanges: async () => {},
    })

    expect(result.passed).toBe(true)
    expect(result.attempts).toBe(2)
    expect(result.changedFiles).toEqual(['file-0.ts', 'file-1.ts'])
    expect(runWorker).toHaveBeenLastCalledWith(expect.objectContaining({
      previousReviewerComment: 'Please fix',
      previousDiffSummary: 'diff 0',
    }))
    expect(statuses).toEqual(['in_progress', 'in_review', 'in_progress', 'in_review', 'done'])
    expect(comments.map(comment => comment.content)).toEqual([
      '워커 에이전트가 AIRI-12 일감을 확인하고 착수했어. (시도 1/5)',
      'initial',
      'diff 0',
      '워커 에이전트가 개발을 마치고 리뷰를 요청했어. (시도 1/5)',
      '리뷰어 에이전트가 AIRI-12 변경사항 리뷰를 시작했어. (시도 1/5)',
      '리뷰 결과: Please fix',
      '워커 에이전트가 AIRI-12 일감을 확인하고 착수했어. (시도 2/5)',
      'Please fix',
      'diff 1',
      '워커 에이전트가 개발을 마치고 리뷰를 요청했어. (시도 2/5)',
      '리뷰어 에이전트가 AIRI-12 변경사항 리뷰를 시작했어. (시도 2/5)',
      '리뷰 결과: Looks good',
    ])
  })

  it('reverts changed files and blocks the work item after max retries', async () => {
    const reverted = vi.fn(async () => {})
    const statuses: WorkItem['status'][] = []

    const result = await runProjectReviewLoop({
      project,
      workItem,
      settings: { maxReviewRetries: 2 },
      runWorker: async input => ({
        changedFiles: [`file-${input.attempt}.ts`],
        diffSummary: `diff ${input.attempt}`,
        comment: 'worker',
      }),
      runReviewer: async () => ({
        passed: false,
        comment: 'Still failing',
      }),
      updateStatus: async (status) => {
        statuses.push(status)
      },
      addComment: async () => {},
      revertChanges: reverted,
    })

    expect(result.passed).toBe(false)
    expect(reverted).toHaveBeenCalledWith(['file-0.ts', 'file-1.ts'])
    expect(statuses.at(-1)).toBe('blocked')
  })
})
