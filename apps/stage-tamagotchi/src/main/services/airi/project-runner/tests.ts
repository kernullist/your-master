import type { ProjectAgentSettings } from '@proj-airi/stage-projects'

import { access, readFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

import { errorMessageFrom } from '@moeru/std'

import { runProjectShellCommand } from './tools'

/**
 * One test command AIRI can run for a registered project.
 */
export interface ProjectTestRecommendation {
  /** Shell command to run from the project root. */
  command: string
  /** Why AIRI chose this command. */
  reason: string
}

/**
 * Test recommendation result for a project.
 */
export interface ProjectTestRecommendationResult {
  /** Recommended commands in priority order. */
  recommendations: ProjectTestRecommendation[]
  /** True when AIRI should ask the user to configure a test command. */
  needsUserCommand: boolean
}

/**
 * One executed validation command and its outcome.
 */
export interface ProjectValidationCommandResult {
  /** Shell command executed from the project root. */
  command: string
  /** Process exit code, or null when the process did not exit normally. */
  exitCode: number | null
  /** True when the process exceeded the configured timeout. */
  timedOut: boolean
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  }
  catch {
    return false
  }
}

async function readPackageScripts(projectRoot: string): Promise<Record<string, string>> {
  const packageJsonPath = join(projectRoot, 'package.json')
  if (!await fileExists(packageJsonPath))
    return {}

  const raw = await readFile(packageJsonPath, 'utf-8')
  const parsed = JSON.parse(raw) as { scripts?: Record<string, string> }
  return parsed.scripts ?? {}
}

async function detectNodePackageManager(projectRoot: string): Promise<'pnpm' | 'yarn' | 'bun' | 'npm'> {
  if (await fileExists(join(projectRoot, 'pnpm-lock.yaml')))
    return 'pnpm'
  if (await fileExists(join(projectRoot, 'yarn.lock')))
    return 'yarn'
  if (await fileExists(join(projectRoot, 'bun.lockb')) || await fileExists(join(projectRoot, 'bun.lock')))
    return 'bun'
  return 'npm'
}

function nodeRunCommand(packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm', script: string): string {
  switch (packageManager) {
    case 'pnpm':
      return `pnpm ${script}`
    case 'yarn':
      return `yarn ${script}`
    case 'bun':
      return `bun run ${script}`
    case 'npm':
      return `npm run ${script}`
  }
}

function normalizeProjectRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

function createVitestCommand(packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm', files: string[]): string {
  const quotedFiles = files.map(file => file.includes(' ') ? `"${file}"` : file).join(' ')
  switch (packageManager) {
    case 'pnpm':
      return `pnpm exec vitest run ${quotedFiles}`
    case 'yarn':
      return `yarn vitest run ${quotedFiles}`
    case 'bun':
      return `bunx vitest run ${quotedFiles}`
    case 'npm':
      return `npx vitest run ${quotedFiles}`
  }
}

async function collectExistingTestFiles(projectRoot: string, changedFiles: string[]): Promise<string[]> {
  const candidates = new Set<string>()
  for (const file of changedFiles.map(normalizeProjectRelativePath)) {
    const extension = extname(file)
    if (!extension)
      continue

    const directory = dirname(file).replace(/\\/g, '/')
    const name = basename(file, extension)
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) {
      candidates.add(file)
      continue
    }

    for (const testExtension of ['.test.ts', '.test.tsx', '.spec.ts', '.spec.tsx', '.test.js', '.spec.js']) {
      candidates.add(`${directory}/${name}${testExtension}`)
      candidates.add(`${directory}/__tests__/${name}${testExtension}`)
    }
  }

  const existing: string[] = []
  for (const candidate of candidates) {
    if (await fileExists(join(projectRoot, candidate)))
      existing.push(candidate)
  }
  return existing
}

/**
 * Normalizes suggested validation commands from model output.
 *
 * Before:
 * - " Inspect git diff "
 * - "pnpm test:run"
 *
 * After:
 * - "pnpm test:run"
 */
export function normalizeSuggestedTestCommands(commands: string[] = []): string[] {
  const commandPrefix = /^(?:(?:pnpm|npm|yarn|bun|cargo|go|python|pytest|vitest|npx|node|deno|dotnet|gradle|mvn)(?:\s|$)|\.\/)/i
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const command of commands) {
    const trimmed = command.trim()
    if (!trimmed || !commandPrefix.test(trimmed) || seen.has(trimmed))
      continue

    seen.add(trimmed)
    normalized.push(trimmed)
  }

  return normalized
}

/**
 * Recommends project test commands from common local project markers.
 *
 * Use when:
 * - AIRI prepares to validate a worker change
 * - The project has no explicit user-provided test command
 *
 * Expects:
 * - `projectRoot` points to the registered local project folder
 *
 * Returns:
 * - Ordered test command recommendations, or `needsUserCommand=true`
 */
export async function recommendProjectTestCommands(projectRoot: string): Promise<ProjectTestRecommendationResult> {
  const recommendations: ProjectTestRecommendation[] = []
  const scripts = await readPackageScripts(projectRoot)
  const packageManager = await detectNodePackageManager(projectRoot)

  for (const script of ['test:run', 'test', 'typecheck', 'lint']) {
    if (scripts[script]) {
      recommendations.push({
        command: nodeRunCommand(packageManager, script),
        reason: `package.json has scripts.${script}`,
      })
    }
  }

  if (await fileExists(join(projectRoot, 'Cargo.toml'))) {
    recommendations.push({
      command: 'cargo test',
      reason: 'Cargo.toml detected',
    })
  }

  if (await fileExists(join(projectRoot, 'go.mod'))) {
    recommendations.push({
      command: 'go test ./...',
      reason: 'go.mod detected',
    })
  }

  if (await fileExists(join(projectRoot, 'pyproject.toml')) || await fileExists(join(projectRoot, 'pytest.ini'))) {
    recommendations.push({
      command: 'python -m pytest',
      reason: 'Python test configuration detected',
    })
  }

  return {
    recommendations,
    needsUserCommand: recommendations.length === 0,
  }
}

/**
 * Recommends tests closest to the changed files.
 *
 * Use when:
 * - Worker changed source files and AIRI should validate the smallest likely test set first
 * - The project uses Vitest-style sibling or `__tests__` files
 *
 * Expects:
 * - `changedFiles` are project-relative paths from git or worker tools
 *
 * Returns:
 * - Impacted test commands before broader package scripts
 */
export async function recommendImpactedProjectTestCommands(params: {
  changedFiles: string[]
  projectRoot: string
}): Promise<ProjectTestRecommendation[]> {
  const testFiles = await collectExistingTestFiles(params.projectRoot, params.changedFiles)
  if (testFiles.length === 0)
    return []

  const packageManager = await detectNodePackageManager(params.projectRoot)
  return [{
    command: createVitestCommand(packageManager, testFiles.slice(0, 10)),
    reason: `test files near changed files: ${testFiles.slice(0, 10).join(', ')}`,
  }]
}

/**
 * Selects validation commands from configured, suggested, and inferred sources.
 *
 * Use when:
 * - Worker or reviewer agents need deterministic validation command choices
 * - Model-suggested commands should be considered without losing local heuristics
 *
 * Expects:
 * - Suggested commands are already user-safe enough for policy checks
 *
 * Returns:
 * - Ordered, de-duplicated commands and the original no-command hint
 */
export async function selectProjectValidationCommands(params: {
  changedFiles?: string[]
  configuredCommand?: string
  maxCommands?: number
  projectRoot: string
  suggestedCommands?: string[]
  verifierCommands?: string[]
}): Promise<ProjectTestRecommendationResult> {
  const recommendations = await recommendProjectTestCommands(params.projectRoot)
  const selected: ProjectTestRecommendation[] = []
  const seen = new Set<string>()

  const add = (command: string | undefined, reason: string) => {
    const trimmed = command?.trim()
    if (!trimmed || seen.has(trimmed))
      return

    seen.add(trimmed)
    selected.push({ command: trimmed, reason })
  }

  add(params.configuredCommand, 'project configured test command')
  for (const command of normalizeSuggestedTestCommands(params.verifierCommands)) {
    add(command, 'project verifier command')
  }

  for (const command of normalizeSuggestedTestCommands(params.suggestedCommands)) {
    add(command, 'project manager or worker suggested validation')
  }

  for (const recommendation of await recommendImpactedProjectTestCommands({
    changedFiles: params.changedFiles ?? [],
    projectRoot: params.projectRoot,
  })) {
    add(recommendation.command, recommendation.reason)
  }

  const hasTypedChanges = (params.changedFiles ?? []).some(file => /\.(?:cts|mts|ts|tsx|vue)$/.test(file))
  const typecheck = recommendations.recommendations.find(item => /\btypecheck\b/.test(item.command))
  if (hasTypedChanges) {
    add(typecheck?.command, typecheck?.reason ?? 'typed source changes detected')
  }

  for (const recommendation of recommendations.recommendations) {
    if (hasTypedChanges && recommendation.command === typecheck?.command)
      continue

    add(recommendation.command, recommendation.reason)
  }

  return {
    recommendations: selected.slice(0, params.maxCommands ?? 3),
    needsUserCommand: selected.length === 0 && recommendations.needsUserCommand,
  }
}

function formatValidationCommandResult(result: ProjectValidationCommandResult): string {
  return [
    `Command: ${result.command}`,
    `Exit code: ${result.exitCode ?? 'null'}`,
    result.timedOut ? 'Timed out: true' : 'Timed out: false',
  ].join('\n')
}

/**
 * Runs selected validation commands for a project.
 *
 * Use when:
 * - Worker changes should be validated before review
 * - Suggested tests from the project manager or worker should be tried first
 *
 * Expects:
 * - Test failures are recorded but the reviewer makes the final pass/block decision
 *
 * Returns:
 * - Commands, exit codes, and a short summary suitable for a work item comment
 *
 * Call stack:
 *
 * project runner loop
 *   -> {@link runProjectTestCommand}
 *     -> {@link selectProjectValidationCommands}
 *       -> {@link runProjectShellCommand}
 */
export async function runProjectTestCommand(params: {
  changedFiles?: string[]
  projectRoot: string
  settings: Pick<ProjectAgentSettings, 'shellAllowlist' | 'shellDenylist' | 'timeoutMs'> & Partial<Pick<ProjectAgentSettings, 'verifierCommands'>>
  configuredCommand?: string
  suggestedCommands?: string[]
}): Promise<{ command?: string, commands: ProjectValidationCommandResult[], exitCode?: number | null, summary: string }> {
  const selected = await selectProjectValidationCommands({
    changedFiles: params.changedFiles,
    configuredCommand: params.configuredCommand,
    projectRoot: params.projectRoot,
    suggestedCommands: params.suggestedCommands,
    verifierCommands: params.settings.verifierCommands,
  })
  if (selected.recommendations.length === 0) {
    return {
      commands: [],
      summary: 'No test command could be inferred. AIRI should ask the user to configure one.',
    }
  }

  const commands: ProjectValidationCommandResult[] = []
  const summaries: string[] = []
  for (const recommendation of selected.recommendations) {
    try {
      const result = await runProjectShellCommand({
        projectRoot: params.projectRoot,
        command: recommendation.command,
        settings: params.settings,
      })
      const commandResult: ProjectValidationCommandResult = {
        command: recommendation.command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      }
      commands.push(commandResult)
      summaries.push([
        formatValidationCommandResult(commandResult),
        `Reason: ${recommendation.reason}`,
        result.stdout ? `stdout: ${result.stdout.slice(0, 1000)}` : '',
        result.stderr ? `stderr: ${result.stderr.slice(0, 1000)}` : '',
      ].filter(Boolean).join('\n'))
      if (result.exitCode !== 0 || result.timedOut)
        break
    }
    catch (error) {
      const commandResult: ProjectValidationCommandResult = {
        command: recommendation.command,
        exitCode: null,
        timedOut: false,
      }
      commands.push(commandResult)
      summaries.push([
        formatValidationCommandResult(commandResult),
        `Reason: ${recommendation.reason}`,
        `Error: ${errorMessageFrom(error) ?? 'unknown error'}`,
      ].join('\n'))
      break
    }
  }

  return {
    command: commands[0]?.command,
    commands,
    exitCode: commands.at(-1)?.exitCode,
    summary: summaries.join('\n\n---\n\n'),
  }
}
