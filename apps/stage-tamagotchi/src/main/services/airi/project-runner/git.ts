import type { WorkItem } from '@proj-airi/stage-projects'

import { spawn } from 'node:child_process'
import { basename, dirname, join } from 'node:path'

import { resolveProjectToolPath } from './tools'

/**
 * Result of one git command.
 */
export interface GitCommandResult {
  /** Git exit code. */
  exitCode: number | null
  /** Captured stdout. */
  stdout: string
  /** Captured stderr. */
  stderr: string
}

/**
 * Result of AIRI's automatic commit attempt.
 */
export interface AgentCommitResult {
  /** True when git commit succeeded. */
  committed: boolean
  /** Commit hash when available. */
  hash?: string
  /** Commit message AIRI attempted. */
  message: string
  /** Failure summary when commit failed. */
  error?: string
}

/**
 * Result of integrating an agent branch back into the user's project worktree.
 */
export interface AgentIntegrationResult {
  /** True when the agent commit was applied to the original project worktree. */
  integrated: boolean
  /** True when git reported a content conflict and AIRI aborted the cherry-pick. */
  conflict: boolean
  /** Commit hash currently checked out in the original project after integration. */
  hash?: string
  /** Failure summary shown to the board when integration is unsafe or conflicted. */
  error?: string
}

/**
 * Metadata for an isolated agent git worktree.
 */
export interface AgentWorktree {
  /** Absolute path where worker/reviewer tools should run. */
  path: string
  /** Branch checked out inside the worktree. */
  branchName: string
}

const projectIntegrationQueues = new Map<string, Promise<void>>()

/**
 * Runs git with array arguments from a project root.
 *
 * Use when:
 * - AIRI needs git operations without shell interpolation
 *
 * Expects:
 * - `args` are trusted internal git subcommands, not raw LLM shell strings
 *
 * Returns:
 * - Captured git output
 */
export async function runGit(projectRoot: string, args: string[]): Promise<GitCommandResult> {
  const cwd = resolveProjectToolPath(projectRoot, '.').absolutePath
  return await new Promise<GitCommandResult>((resolvePromise, reject) => {
    // Git is executed without a shell so file paths are passed as literal arguments.
    const child = spawn('git', args, {
      cwd,
      shell: false,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf-8')
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf-8')
    })
    child.on('error', reject)
    child.on('close', exitCode => resolvePromise({ exitCode, stdout, stderr }))
  })
}

/**
 * Runs one critical git integration step at a time for a project.
 *
 * Use when:
 * - Multiple worker/reviewer branches may finish at nearly the same time
 * - AIRI needs the original project worktree to receive commits in a stable order
 *
 * Expects:
 * - `task` does not wait for user input while holding the project queue
 *
 * Returns:
 * - The task result after every earlier integration for the same project has completed
 */
export async function runWithProjectGitIntegrationLock<T>(projectRoot: string, task: () => Promise<T>): Promise<T> {
  const key = resolveProjectToolPath(projectRoot, '.').absolutePath
  const previous = projectIntegrationQueues.get(key)?.catch(() => {}) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.then(() => current)
  projectIntegrationQueues.set(key, queued)

  await previous
  try {
    return await task()
  }
  finally {
    release()
    if (projectIntegrationQueues.get(key) === queued)
      projectIntegrationQueues.delete(key)
  }
}

function normalizeAgentChangedFiles(projectRoot: string, files: string[]): string[] {
  return [...new Set(files)]
    .map(file => resolveProjectToolPath(projectRoot, file).relativePath)
    .filter(file => file !== '.')
}

function trimGitOutput(result: GitCommandResult): string {
  return (result.stderr || result.stdout).trim()
}

/**
 * Normalizes text for git branch and worktree folder names.
 *
 * Before:
 * - "AIRI-12 Add Board!"
 *
 * After:
 * - "airi-12-add-board"
 */
export function normalizeWorktreeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'work-item'
}

/**
 * Builds the default branch name used for an agent worktree.
 *
 * Use when:
 * - AIRI needs a deterministic branch for one work item
 * - The branch should be separate from the user's current branch
 *
 * Expects:
 * - Work item identifier is stable and unique enough for the active project
 *
 * Returns:
 * - A git branch name such as `airi/work/airi-12`
 */
export function buildAgentWorktreeBranchName(workItem: Pick<WorkItem, 'identifier'>): string {
  return `airi/work/${normalizeWorktreeSlug(workItem.identifier)}`
}

/**
 * Builds a unique branch name for a specific agent run.
 *
 * Use when:
 * - The same work item may be retried or restarted while a previous branch still exists
 * - Concurrent agent runs must never reset each other's branches
 *
 * Expects:
 * - `runId` is stable for one runner invocation
 *
 * Returns:
 * - A git branch name such as `airi/work/airi-12/run-abc`
 */
export function buildAgentRunWorktreeBranchName(workItem: Pick<WorkItem, 'identifier'>, runId: string): string {
  return `${buildAgentWorktreeBranchName(workItem)}/${normalizeWorktreeSlug(runId)}`
}

/**
 * Builds the default local path for an agent worktree.
 *
 * Use when:
 * - AIRI starts worker/reviewer execution for a git-backed project
 * - The original project folder should remain untouched by agent edits
 *
 * Expects:
 * - `projectRoot` points to the registered project folder
 *
 * Returns:
 * - A sibling `.airi-worktrees/<project>/<work-item>` path outside the project root
 */
export function buildAgentWorktreePath(projectRoot: string, workItem: Pick<WorkItem, 'identifier'>): string {
  const root = resolveProjectToolPath(projectRoot, '.').absolutePath
  return join(dirname(root), '.airi-worktrees', basename(root), normalizeWorktreeSlug(workItem.identifier))
}

/**
 * Builds a unique worktree path for a specific agent run.
 *
 * Use when:
 * - AIRI starts a runner invocation that should not reuse an older checkout folder
 *
 * Expects:
 * - `runId` is stable for one runner invocation
 *
 * Returns:
 * - A sibling `.airi-worktrees/<project>/<work-item>/<run-id>` path
 */
export function buildAgentRunWorktreePath(projectRoot: string, workItem: Pick<WorkItem, 'identifier'>, runId: string): string {
  return join(buildAgentWorktreePath(projectRoot, workItem), normalizeWorktreeSlug(runId))
}

/**
 * Creates a git worktree for one agent-owned work item branch.
 *
 * Use when:
 * - Worker/reviewer tools should run outside the user's currently open worktree
 * - AIRI needs commit/revert isolation per work item
 *
 * Expects:
 * - `projectRoot` is a git repository
 * - The target worktree path does not already exist
 *
 * Returns:
 * - Worktree path and branch name to persist on the run record
 *
 * Call stack:
 *
 * project runner
 *   -> {@link createAgentWorktree}
 *     -> {@link runGit}
 *       -> git worktree add
 */
export async function createAgentWorktree(params: {
  projectRoot: string
  workItem: Pick<WorkItem, 'identifier'>
  baseRef?: string
  branchName?: string
  worktreePath?: string
}): Promise<AgentWorktree> {
  const branchName = params.branchName ?? buildAgentWorktreeBranchName(params.workItem)
  const worktreePath = params.worktreePath ?? buildAgentWorktreePath(params.projectRoot, params.workItem)
  const baseRef = params.baseRef ?? 'HEAD'
  const result = await runGit(params.projectRoot, ['worktree', 'add', '-B', branchName, worktreePath, baseRef])
  if (result.exitCode !== 0)
    throw new Error(result.stderr || result.stdout || 'git worktree add failed')

  return {
    path: worktreePath,
    branchName,
  }
}

/**
 * Removes an agent-owned git worktree.
 *
 * Use when:
 * - A blocked run should clean up isolated files
 * - AIRI no longer needs the temporary worktree checkout
 *
 * Expects:
 * - `projectRoot` is the registered git repository
 * - `worktreePath` is a path previously created for AIRI agent work
 *
 * Returns:
 * - Git command result from `git worktree remove --force`
 */
export async function removeAgentWorktree(projectRoot: string, worktreePath: string): Promise<GitCommandResult> {
  return await runGit(projectRoot, ['worktree', 'remove', '--force', worktreePath])
}

/**
 * Builds AIRI's default conventional commit message.
 *
 * Use when:
 * - Auto commit is enabled and review passed
 *
 * Expects:
 * - Work item identifier is already normalized
 *
 * Returns:
 * - Commit message such as `feat: add project board (AIRI-12)`
 */
export function buildWorkItemCommitMessage(workItem: Pick<WorkItem, 'commitPrefix' | 'identifier' | 'title'>): string {
  const title = workItem.title.trim()
  const normalizedTitle = title ? `${title[0]?.toLowerCase() ?? ''}${title.slice(1)}` : 'complete work item'
  const baseMessage = `feat: ${normalizedTitle} (${workItem.identifier})`
  const commitPrefix = workItem.commitPrefix?.trim()
  if (!commitPrefix)
    return baseMessage

  return `${commitPrefix} [feat] ${normalizedTitle} (${workItem.identifier})`
}

/**
 * Creates a compact git diff summary for files changed by the worker.
 *
 * Use when:
 * - AIRI stores a short diff note on a work item
 *
 * Expects:
 * - Files are project-relative paths
 *
 * Returns:
 * - `git diff --stat` output, or an empty string when there is no diff
 */
export async function getAgentDiffSummary(projectRoot: string, files: string[]): Promise<string> {
  const normalizedFiles = normalizeAgentChangedFiles(projectRoot, files)
  if (normalizedFiles.length === 0)
    return ''

  const result = await runGit(projectRoot, ['diff', '--stat', '--', ...normalizedFiles])
  return result.stdout.trim()
}

/**
 * Reads changed file paths from a git worktree.
 *
 * Use when:
 * - Worker shell commands may have changed files outside explicit patch tool calls
 * - AIRI needs an agent-owned stage/commit file list
 *
 * Expects:
 * - `projectRoot` is a git repository or git worktree
 *
 * Returns:
 * - Project-relative file paths from `git status --porcelain`
 */
export async function getGitChangedFiles(projectRoot: string): Promise<string[]> {
  const result = await runGit(projectRoot, ['status', '--porcelain'])
  if (result.exitCode !== 0)
    return []

  return result.stdout
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .map((line) => {
      const path = line.slice(3).trim()
      const renamedPath = path.includes(' -> ') ? path.split(' -> ').at(-1) : path
      return renamedPath?.replace(/\\/g, '/') ?? path
    })
    .filter(Boolean)
}

/**
 * Reverts only files changed by the worker agent.
 *
 * Use when:
 * - Review fails after maximum retries
 *
 * Expects:
 * - Project is a git repository
 *
 * Returns:
 * - Git command result from `git restore`
 */
export async function revertAgentChangedFiles(projectRoot: string, files: string[]): Promise<GitCommandResult> {
  const normalizedFiles = normalizeAgentChangedFiles(projectRoot, files)
  if (normalizedFiles.length === 0) {
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
    }
  }
  return await runGit(projectRoot, ['restore', '--', ...normalizedFiles])
}

/**
 * Stages and commits only files changed by the worker agent.
 *
 * Use when:
 * - Review passed and auto commit is enabled
 *
 * Expects:
 * - Project is a git repository and `files` only contains agent-owned paths
 *
 * Returns:
 * - Commit status, hash, message, or failure summary
 *
 * Call stack:
 *
 * project runner
 *   -> {@link commitAgentChangedFiles}
 *     -> {@link runGit}
 *       -> git add/commit/rev-parse
 */
export async function commitAgentChangedFiles(params: {
  projectRoot: string
  files: string[]
  workItem: Pick<WorkItem, 'commitPrefix' | 'identifier' | 'title'>
  message?: string
}): Promise<AgentCommitResult> {
  const message = params.message ?? buildWorkItemCommitMessage(params.workItem)
  const normalizedFiles = normalizeAgentChangedFiles(params.projectRoot, params.files)
  if (normalizedFiles.length === 0) {
    return {
      committed: false,
      message,
      error: 'No agent-changed files to commit.',
    }
  }

  const add = await runGit(params.projectRoot, ['add', '--', ...normalizedFiles])
  if (add.exitCode !== 0) {
    return {
      committed: false,
      message,
      error: add.stderr || add.stdout || 'git add failed',
    }
  }

  const hasStagedDiff = await runGit(params.projectRoot, ['diff', '--cached', '--quiet', '--', ...normalizedFiles])
  if (hasStagedDiff.exitCode === 0) {
    return {
      committed: false,
      message,
      error: 'No staged changes for agent-changed files.',
    }
  }

  const commit = await runGit(params.projectRoot, ['commit', '-m', message])
  if (commit.exitCode !== 0) {
    return {
      committed: false,
      message,
      error: commit.stderr || commit.stdout || 'git commit failed',
    }
  }

  const hash = await runGit(params.projectRoot, ['rev-parse', '--short', 'HEAD'])
  return {
    committed: true,
    hash: hash.stdout.trim() || undefined,
    message,
  }
}

/**
 * Integrates a committed agent branch into the user's original project worktree.
 *
 * Use when:
 * - Auto commit succeeded inside an isolated agent worktree
 * - AIRI should serialize multiple finished agent branches before applying them
 *
 * Expects:
 * - `branchName` points at the agent commit to cherry-pick
 * - The original project worktree should be clean before integration starts
 *
 * Returns:
 * - Integration status; on conflict, the cherry-pick is aborted and the branch is preserved
 *
 * Call stack:
 *
 * project runner
 *   -> {@link integrateAgentBranchIntoProject}
 *     -> {@link runWithProjectGitIntegrationLock}
 *       -> git cherry-pick
 */
export async function integrateAgentBranchIntoProject(params: {
  branchName: string
  projectRoot: string
}): Promise<AgentIntegrationResult> {
  return await runWithProjectGitIntegrationLock(params.projectRoot, async () => {
    const dirty = await runGit(params.projectRoot, ['status', '--porcelain'])
    if (dirty.exitCode !== 0) {
      return {
        integrated: false,
        conflict: false,
        error: trimGitOutput(dirty) || 'git status failed before agent branch integration.',
      }
    }
    if (dirty.stdout.trim()) {
      return {
        integrated: false,
        conflict: false,
        error: 'Original project worktree has local changes. Agent branch was preserved for manual integration.',
      }
    }

    const cherryPick = await runGit(params.projectRoot, ['cherry-pick', params.branchName])
    if (cherryPick.exitCode !== 0) {
      await runGit(params.projectRoot, ['cherry-pick', '--abort'])
      return {
        integrated: false,
        conflict: true,
        error: trimGitOutput(cherryPick) || 'git cherry-pick failed while integrating the agent branch.',
      }
    }

    const hash = await runGit(params.projectRoot, ['rev-parse', '--short', 'HEAD'])
    return {
      integrated: true,
      conflict: false,
      hash: hash.stdout.trim() || undefined,
    }
  })
}
