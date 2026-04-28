import * as v from 'valibot'

/** Schema for one worker/reviewer execution record. */
export const workItemRunRecordSchema = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  workItemId: v.pipe(v.string(), v.nonEmpty()),
  status: v.picklist(['queued', 'in_progress', 'in_review', 'done', 'blocked']),
  attempt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  changedFiles: v.array(v.string()),
  worktreePath: v.optional(v.string()),
  branchName: v.optional(v.string()),
  diffSummary: v.optional(v.string()),
  workerComment: v.optional(v.string()),
  reviewerComment: v.optional(v.string()),
  testCommand: v.optional(v.string()),
  testSummary: v.optional(v.string()),
  commitHash: v.optional(v.string()),
  commitMessage: v.optional(v.string()),
  error: v.optional(v.string()),
  startedAt: v.number(),
  finishedAt: v.optional(v.number()),
})
