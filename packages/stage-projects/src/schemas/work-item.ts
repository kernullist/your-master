import * as v from 'valibot'

export const workItemStatusSchema = v.picklist(['todo', 'in_progress', 'in_review', 'done', 'blocked'])

export const createWorkItemInputSchema = v.object({
  projectId: v.pipe(v.string(), v.nonEmpty()),
  identifier: v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9]*-\d+$/)),
  title: v.pipe(v.string(), v.nonEmpty()),
  goal: v.pipe(v.string(), v.nonEmpty()),
  acceptanceCriteria: v.pipe(v.array(v.pipe(v.string(), v.nonEmpty())), v.minLength(1)),
  commitPrefix: v.optional(v.pipe(v.string(), v.nonEmpty())),
  dueAt: v.optional(v.number()),
})

export const updateWorkItemInputSchema = v.partial(v.object({
  title: v.pipe(v.string(), v.nonEmpty()),
  goal: v.pipe(v.string(), v.nonEmpty()),
  acceptanceCriteria: v.pipe(v.array(v.pipe(v.string(), v.nonEmpty())), v.minLength(1)),
  commitPrefix: v.nullable(v.pipe(v.string(), v.nonEmpty())),
  status: workItemStatusSchema,
  position: v.number(),
  dueAt: v.nullable(v.number()),
}))

export const workItemSchema = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  projectId: v.pipe(v.string(), v.nonEmpty()),
  identifier: v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9]*-\d+$/)),
  title: v.pipe(v.string(), v.nonEmpty()),
  goal: v.pipe(v.string(), v.nonEmpty()),
  acceptanceCriteria: v.pipe(v.array(v.pipe(v.string(), v.nonEmpty())), v.minLength(1)),
  commitPrefix: v.optional(v.pipe(v.string(), v.nonEmpty())),
  status: workItemStatusSchema,
  position: v.number(),
  dueAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
})

export const workItemCommentSchema = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  workItemId: v.pipe(v.string(), v.nonEmpty()),
  actorType: v.picklist(['user', 'airi', 'worker', 'reviewer', 'system']),
  content: v.pipe(v.string(), v.nonEmpty()),
  kind: v.picklist(['comment', 'status', 'worker', 'review', 'diff', 'test', 'commit']),
  createdAt: v.number(),
})
