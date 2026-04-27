import * as v from 'valibot'

export const projectRegistrationInputSchema = v.object({
  rootPath: v.pipe(v.string(), v.nonEmpty()),
  name: v.pipe(v.string(), v.nonEmpty()),
  issuePrefix: v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9]*$/)),
  gitEnabled: v.boolean(),
})

export const projectSchema = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  name: v.pipe(v.string(), v.nonEmpty()),
  issuePrefix: v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9]*$/)),
  rootPath: v.pipe(v.string(), v.nonEmpty()),
  gitEnabled: v.boolean(),
  testCommand: v.optional(v.string()),
  metadata: v.record(v.string(), v.unknown()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
