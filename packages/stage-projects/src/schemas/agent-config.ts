import * as v from 'valibot'

export const agentModelConfigSchema = v.object({
  provider: v.picklist(['lm-studio', 'ollama', 'openrouter', 'codex-cli']),
  model: v.string(),
  baseUrl: v.optional(v.string()),
  apiKey: v.optional(v.string()),
  systemPrompt: v.pipe(v.string(), v.nonEmpty()),
})

export const projectAgentSettingsSchema = v.object({
  projectManager: agentModelConfigSchema,
  worker: agentModelConfigSchema,
  reviewer: agentModelConfigSchema,
  maxReviewRetries: v.pipe(v.number(), v.integer(), v.minValue(1)),
  maxConcurrentRuns: v.pipe(v.number(), v.integer(), v.minValue(1)),
  autoCommit: v.boolean(),
  verifierCommands: v.optional(v.array(v.string()), []),
  shellDenylist: v.array(v.string()),
  shellAllowlist: v.array(v.string()),
  forbiddenPathPatterns: v.array(v.string()),
  timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
})
