import type { ProjectAgentSettings } from '@proj-airi/stage-projects'

import { spawn } from 'node:child_process'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

import { evaluateShellCommandPolicy, isPathAllowed } from '@proj-airi/stage-projects'

/**
 * Result returned after running a worker shell command.
 */
export interface ProjectShellResult {
  /** Process exit code, or null when the process was terminated by timeout/signal. */
  exitCode: number | null
  /** Captured stdout, truncated to the runner limit. */
  stdout: string
  /** Captured stderr, truncated to the runner limit. */
  stderr: string
  /** True when AIRI killed the process because it exceeded the configured timeout. */
  timedOut: boolean
}

/**
 * One text search match inside a project file.
 */
export interface ProjectSearchMatch {
  /** Project-relative file path. */
  path: string
  /** One-based line number. */
  line: number
  /** Matching line text. */
  text: string
}

/**
 * One directory entry visible to the worker.
 */
export interface ProjectDirectoryEntry {
  /** Project-relative entry path. */
  path: string
  /** File type used by AIRI to decide whether it can read or recurse. */
  type: 'file' | 'directory' | 'other'
}

const DEFAULT_OUTPUT_LIMIT = 1024 * 256
const DEFAULT_SEARCH_LIMIT = 100
const SKIPPED_SEARCH_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'out', '.turbo'])

/**
 * Resolves a project-relative path and rejects path traversal.
 *
 * Use when:
 * - Worker file tools receive a path from an LLM tool call
 * - The path must stay inside the registered project folder
 *
 * Expects:
 * - `projectRoot` is an absolute or process-resolvable local folder path
 *
 * Returns:
 * - Absolute path plus normalized project-relative path
 */
export function resolveProjectToolPath(
  projectRoot: string,
  relativePath: string,
  forbiddenPathPatterns: string[] = [],
): { absolutePath: string, relativePath: string } {
  const root = resolve(projectRoot)
  const absolutePath = resolve(root, relativePath || '.')
  const staysInsideRoot = absolutePath === root || absolutePath.startsWith(`${root}${sep}`)
  if (!staysInsideRoot)
    throw new Error(`Path escapes project root: ${relativePath}`)

  const normalizedRelativePath = relative(root, absolutePath).replace(/\\/g, '/') || '.'
  if (!isPathAllowed(normalizedRelativePath, forbiddenPathPatterns))
    throw new Error(`Path is forbidden by project policy: ${normalizedRelativePath}`)

  return {
    absolutePath,
    relativePath: normalizedRelativePath,
  }
}

/**
 * Lists a project directory without leaving the project root.
 *
 * Use when:
 * - Worker agent needs to discover nearby files before reading or patching
 *
 * Expects:
 * - Directory exists and is readable
 *
 * Returns:
 * - Sorted project-relative entries with coarse file type
 */
export async function listProjectDirectory(params: {
  projectRoot: string
  relativePath?: string
  forbiddenPathPatterns?: string[]
}): Promise<ProjectDirectoryEntry[]> {
  const target = resolveProjectToolPath(params.projectRoot, params.relativePath ?? '.', params.forbiddenPathPatterns)
  const entries = await readdir(target.absolutePath, { withFileTypes: true })
  return entries
    .map((entry): ProjectDirectoryEntry => ({
      path: target.relativePath === '.' ? entry.name : `${target.relativePath}/${entry.name}`,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Reads one project file as UTF-8 text.
 *
 * Use when:
 * - Worker agent needs source context before generating a patch
 *
 * Expects:
 * - The target is a text file under the project root
 *
 * Returns:
 * - UTF-8 file contents
 */
export async function readProjectFile(params: {
  projectRoot: string
  relativePath: string
  forbiddenPathPatterns?: string[]
}): Promise<string> {
  const target = resolveProjectToolPath(params.projectRoot, params.relativePath, params.forbiddenPathPatterns)
  return await readFile(target.absolutePath, 'utf-8')
}

/**
 * Replaces an exact text fragment in one project file.
 *
 * Use when:
 * - Worker agent proposes a focused edit and AIRI needs deterministic patch behavior
 *
 * Expects:
 * - `search` appears exactly once unless `replaceAll` is true
 *
 * Returns:
 * - Number of replacements applied
 */
export async function replaceInProjectFile(params: {
  projectRoot: string
  relativePath: string
  search: string
  replace: string
  replaceAll?: boolean
  forbiddenPathPatterns?: string[]
}): Promise<{ replacements: number }> {
  const target = resolveProjectToolPath(params.projectRoot, params.relativePath, params.forbiddenPathPatterns)
  const current = await readFile(target.absolutePath, 'utf-8')
  const occurrences = current.split(params.search).length - 1
  if (occurrences === 0)
    throw new Error(`Patch search text was not found in ${target.relativePath}`)
  if (occurrences > 1 && !params.replaceAll)
    throw new Error(`Patch search text matched ${occurrences} times in ${target.relativePath}`)

  const next = params.replaceAll
    ? current.split(params.search).join(params.replace)
    : current.replace(params.search, params.replace)
  await writeFile(target.absolutePath, next)
  return { replacements: params.replaceAll ? occurrences : 1 }
}

async function collectSearchFiles(params: {
  projectRoot: string
  relativePath: string
  forbiddenPathPatterns: string[]
  files: string[]
  maxFiles: number
}) {
  if (params.files.length >= params.maxFiles)
    return

  const target = resolveProjectToolPath(params.projectRoot, params.relativePath, params.forbiddenPathPatterns)
  const targetStat = await stat(target.absolutePath)
  if (targetStat.isFile()) {
    params.files.push(target.relativePath)
    return
  }
  if (!targetStat.isDirectory())
    return

  const entries = await readdir(target.absolutePath, { withFileTypes: true })
  for (const entry of entries) {
    if (params.files.length >= params.maxFiles)
      return
    if (entry.isDirectory() && SKIPPED_SEARCH_DIRECTORIES.has(entry.name))
      continue

    const childPath = target.relativePath === '.' ? entry.name : `${target.relativePath}/${entry.name}`
    await collectSearchFiles({
      ...params,
      relativePath: childPath,
    })
  }
}

/**
 * Searches text files under a project path.
 *
 * Use when:
 * - Worker agent needs grep-like context without unrestricted shell access
 *
 * Expects:
 * - Binary files may be skipped when UTF-8 reading fails
 *
 * Returns:
 * - Matching lines up to the provided limit
 */
export async function searchProjectFiles(params: {
  projectRoot: string
  query: string
  relativePath?: string
  forbiddenPathPatterns?: string[]
  maxMatches?: number
  maxFiles?: number
}): Promise<ProjectSearchMatch[]> {
  const files: string[] = []
  const matches: ProjectSearchMatch[] = []
  const maxMatches = params.maxMatches ?? DEFAULT_SEARCH_LIMIT
  await collectSearchFiles({
    projectRoot: params.projectRoot,
    relativePath: params.relativePath ?? '.',
    forbiddenPathPatterns: params.forbiddenPathPatterns ?? [],
    files,
    maxFiles: params.maxFiles ?? 2000,
  })

  for (const file of files) {
    if (matches.length >= maxMatches)
      break

    let text = ''
    try {
      text = await readProjectFile({
        projectRoot: params.projectRoot,
        relativePath: file,
        forbiddenPathPatterns: params.forbiddenPathPatterns,
      })
    }
    catch {
      continue
    }

    const lines = text.split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      if (!line.includes(params.query))
        continue
      matches.push({
        path: file,
        line: index + 1,
        text: line,
      })
      if (matches.length >= maxMatches)
        break
    }
  }

  return matches
}

function truncateOutput(output: string, limit: number): string {
  if (output.length <= limit)
    return output
  return `${output.slice(0, limit)}\n[truncated ${output.length - limit} bytes]`
}

/**
 * Runs a shell command under the project root after AIRI policy checks.
 *
 * Use when:
 * - Worker agent needs package manager, test, formatter, or language tooling commands
 *
 * Expects:
 * - Destructive command tokens are blocked by `settings.shellDenylist`
 *
 * Returns:
 * - Exit code and captured stdout/stderr
 *
 * Call stack:
 *
 * project runner loop
 *   -> {@link runProjectShellCommand}
 *     -> {@link evaluateShellCommandPolicy}
 *       -> node:child_process spawn
 */
export async function runProjectShellCommand(params: {
  projectRoot: string
  command: string
  settings: Pick<ProjectAgentSettings, 'shellAllowlist' | 'shellDenylist' | 'timeoutMs'>
  outputLimit?: number
}): Promise<ProjectShellResult> {
  const policy = evaluateShellCommandPolicy(params.command, params.settings)
  if (!policy.allowed)
    throw new Error(policy.reason ?? 'Command is not allowed.')

  const cwd = resolveProjectToolPath(params.projectRoot, '.').absolutePath
  const outputLimit = params.outputLimit ?? DEFAULT_OUTPUT_LIMIT

  return await new Promise<ProjectShellResult>((resolvePromise, reject) => {
    // Process execution is intentionally scoped to cwd and timeout because worker LLMs can call this tool.
    const child = spawn(params.command, {
      cwd,
      shell: true,
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, params.settings.timeoutMs)

    child.stdout?.on('data', (chunk) => {
      stdout = truncateOutput(stdout + chunk.toString('utf-8'), outputLimit)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = truncateOutput(stderr + chunk.toString('utf-8'), outputLimit)
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timeout)
      resolvePromise({
        exitCode,
        stdout,
        stderr,
        timedOut,
      })
    })
  })
}

/**
 * Reads git dirty files for a project.
 *
 * Use when:
 * - AIRI must stop and ask the user before worker edits begin on a dirty worktree
 *
 * Expects:
 * - Non-git projects are allowed; git failure returns an empty clean result with stderr
 *
 * Returns:
 * - Dirty flag, porcelain file lines, and stderr if git failed
 */
export async function inspectGitDirtyFiles(projectRoot: string): Promise<{ dirty: boolean, files: string[], stderr?: string }> {
  const result = await runProjectShellCommand({
    projectRoot,
    command: 'git status --porcelain',
    settings: {
      shellAllowlist: ['git status'],
      shellDenylist: [],
      timeoutMs: 30000,
    },
  })

  if (result.exitCode !== 0) {
    return {
      dirty: false,
      files: [],
      stderr: result.stderr,
    }
  }

  const files = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  return {
    dirty: files.length > 0,
    files,
  }
}
