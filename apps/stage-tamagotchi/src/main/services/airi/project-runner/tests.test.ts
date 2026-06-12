import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  normalizeSuggestedTestCommands,
  recommendImpactedProjectTestCommands,
  recommendProjectTestCommands,
  runProjectTestCommand,
  selectProjectValidationCommands,
} from './tests'

async function withTempProject<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'airi-project-tests-'))
  try {
    return await fn(root)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('project test recommendations', () => {
  it('prefers package scripts with the detected package manager', async () => {
    await withTempProject(async (root) => {
      await writeFile(join(root, 'pnpm-lock.yaml'), '')
      await writeFile(join(root, 'package.json'), JSON.stringify({
        scripts: {
          'test:run': 'vitest run',
          'typecheck': 'tsc --noEmit',
        },
      }))

      const result = await recommendProjectTestCommands(root)

      expect(result.needsUserCommand).toBe(false)
      expect(result.recommendations[0]).toEqual({
        command: 'pnpm test:run',
        reason: 'package.json has scripts.test:run',
      })
      expect(result.recommendations[1]?.command).toBe('pnpm typecheck')
    })
  })

  it('falls back to Cargo and Go markers', async () => {
    await withTempProject(async (root) => {
      await writeFile(join(root, 'Cargo.toml'), '[package]\nname = "demo"\n')
      await writeFile(join(root, 'go.mod'), 'module demo\n')

      const result = await recommendProjectTestCommands(root)

      expect(result.recommendations.map(item => item.command)).toEqual(['cargo test', 'go test ./...'])
    })
  })

  it('returns a user-action summary when no command can be inferred', async () => {
    await withTempProject(async (root) => {
      const result = await runProjectTestCommand({
        projectRoot: root,
        settings: {
          shellAllowlist: [],
          shellDenylist: ['rm'],
          timeoutMs: 1000,
        },
      })

      expect(result.command).toBeUndefined()
      expect(result.summary).toContain('No test command could be inferred')
    })
  })

  it('keeps typecheck inside the validation budget for typed changes', async () => {
    await withTempProject(async (root) => {
      await writeFile(join(root, 'pnpm-lock.yaml'), '')
      await writeFile(join(root, 'package.json'), JSON.stringify({
        scripts: {
          test: 'vitest run',
          typecheck: 'tsc --noEmit',
        },
      }))

      // ROOT CAUSE:
      //
      // Typed source changes previously appended typecheck after configured,
      // suggested, and generic inferred scripts. The default maxCommands=3
      // could then drop typecheck for Vue/TypeScript work.
      //
      // We fixed this by prioritizing the inferred typecheck command before
      // other inferred package scripts when typed files changed.
      const selected = await selectProjectValidationCommands({
        changedFiles: ['src/App.vue'],
        configuredCommand: 'pnpm lint',
        projectRoot: root,
        suggestedCommands: ['Inspect git diff', 'pnpm exec vitest run src/App.test.ts'],
      })

      expect(normalizeSuggestedTestCommands(['Inspect manually', 'nodeevil run', 'pnpm test'])).toEqual(['pnpm test'])
      expect(selected.recommendations.map(item => item.command)).toEqual([
        'pnpm lint',
        'pnpm exec vitest run src/App.test.ts',
        'pnpm typecheck',
      ])
    })
  })

  it('prioritizes configured verifier commands before model-suggested checks', async () => {
    await withTempProject(async (root) => {
      await writeFile(join(root, 'pnpm-lock.yaml'), '')
      await writeFile(join(root, 'package.json'), JSON.stringify({
        scripts: {
          test: 'vitest run',
          typecheck: 'tsc --noEmit',
        },
      }))

      const selected = await selectProjectValidationCommands({
        changedFiles: ['src/App.vue'],
        projectRoot: root,
        suggestedCommands: ['pnpm exec vitest run src/App.test.ts'],
        verifierCommands: ['pnpm lint', 'pnpm lint', 'Inspect manually'],
      })

      expect(selected.recommendations.map(item => item.command)).toEqual([
        'pnpm lint',
        'pnpm exec vitest run src/App.test.ts',
        'pnpm typecheck',
      ])
      expect(selected.recommendations[0]?.reason).toBe('project verifier command')
    })
  })

  it('prefers tests located near changed files', async () => {
    await withTempProject(async (root) => {
      await writeFile(join(root, 'pnpm-lock.yaml'), '')
      await writeFile(join(root, 'package.json'), JSON.stringify({
        scripts: {
          test: 'vitest run',
          typecheck: 'tsc --noEmit',
        },
      }))
      await writeFile(join(root, 'widget.ts'), 'export const widget = true\n')
      await writeFile(join(root, 'widget.test.ts'), 'import { widget } from "./widget"\n')

      const impacted = await recommendImpactedProjectTestCommands({
        changedFiles: ['widget.ts'],
        projectRoot: root,
      })
      const selected = await selectProjectValidationCommands({
        changedFiles: ['widget.ts'],
        projectRoot: root,
      })

      expect(impacted[0]?.command).toBe('pnpm exec vitest run ./widget.test.ts')
      expect(selected.recommendations[0]?.command).toBe('pnpm exec vitest run ./widget.test.ts')
      expect(selected.recommendations[1]?.command).toBe('pnpm typecheck')
    })
  })
})
