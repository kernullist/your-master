import type { ProjectAgentSettings } from '@proj-airi/stage-projects'

import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

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
 * Runs the first recommended or user-configured test command.
 *
 * Use when:
 * - Worker changes should be validated before review
 *
 * Expects:
 * - Test failures are recorded but do not automatically fail review
 *
 * Returns:
 * - Command, exit code, and short summary suitable for a work item comment
 *
 * Call stack:
 *
 * project runner loop
 *   -> {@link runProjectTestCommand}
 *     -> {@link recommendProjectTestCommands}
 *       -> {@link runProjectShellCommand}
 */
export async function runProjectTestCommand(params: {
  projectRoot: string
  settings: Pick<ProjectAgentSettings, 'shellAllowlist' | 'shellDenylist' | 'timeoutMs'>
  configuredCommand?: string
}): Promise<{ command?: string, exitCode?: number | null, summary: string }> {
  const command = params.configuredCommand || (await recommendProjectTestCommands(params.projectRoot)).recommendations[0]?.command
  if (!command) {
    return {
      summary: 'No test command could be inferred. AIRI should ask the user to configure one.',
    }
  }

  const result = await runProjectShellCommand({
    projectRoot: params.projectRoot,
    command,
    settings: params.settings,
  })
  const summary = [
    `Command: ${command}`,
    `Exit code: ${result.exitCode ?? 'null'}`,
    result.timedOut ? 'Timed out: true' : 'Timed out: false',
    result.stdout ? `stdout: ${result.stdout.slice(0, 1000)}` : '',
    result.stderr ? `stderr: ${result.stderr.slice(0, 1000)}` : '',
  ].filter(Boolean).join('\n')

  return {
    command,
    exitCode: result.exitCode,
    summary,
  }
}
