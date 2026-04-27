import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  recommendProjectTestCommands,
  runProjectTestCommand,
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
})
