export type AgentModelProvider = 'lm-studio' | 'ollama' | 'openrouter' | 'codex-cli'

/**
 * Model runtime used by one project agent role.
 */
export interface AgentModelConfig {
  /** Provider family used by this role. */
  provider: AgentModelProvider
  /** Provider model id. */
  model: string
  /** Optional provider endpoint, usually needed for OpenAI-compatible local providers. */
  baseUrl?: string
  /** Optional API key for remote providers such as OpenRouter. */
  apiKey?: string
  /** Role-specific system prompt. */
  systemPrompt: string
}

/**
 * Global project orchestration settings.
 */
export interface ProjectAgentSettings {
  /** Project manager model that prepares worker/reviewer execution briefs. */
  projectManager: AgentModelConfig
  /** Worker coding agent model. */
  worker: AgentModelConfig
  /** Reviewer agent model. */
  reviewer: AgentModelConfig
  /** Maximum worker/reviewer repair attempts after review feedback. */
  maxReviewRetries: number
  /** Maximum work items AIRI may run at the same time. */
  maxConcurrentRuns: number
  /** Whether AIRI commits automatically after review passes. */
  autoCommit: boolean
  /** Shell command substrings that are denied before execution. */
  shellDenylist: string[]
  /** Shell command prefixes allowed by policy; empty means all non-denied commands. */
  shellAllowlist: string[]
  /** Glob-like path fragments workers must not edit. */
  forbiddenPathPatterns: string[]
  /** Agent timeout in milliseconds. */
  timeoutMs: number
}

/**
 * Default orchestration settings for new AIRI installations.
 */
export const defaultProjectAgentSettings: ProjectAgentSettings = {
  projectManager: {
    provider: 'ollama',
    model: '',
    systemPrompt: 'You are AIRI Project Manager, an orchestration agent that turns work items into concise implementation briefs for worker and reviewer agents.',
  },
  worker: {
    provider: 'ollama',
    model: '',
    systemPrompt: 'You are AIRI Worker, a coding agent that edits files with tools and follows the work item requirements.',
  },
  reviewer: {
    provider: 'ollama',
    model: '',
    systemPrompt: 'You are AIRI Reviewer, a review agent that checks whether requirements are met and obvious bugs were introduced.',
  },
  maxReviewRetries: 5,
  maxConcurrentRuns: 2,
  autoCommit: true,
  shellDenylist: ['rm', 'del', 'git reset', 'git clean'],
  shellAllowlist: [],
  forbiddenPathPatterns: [],
  timeoutMs: 30 * 60 * 1000,
}
