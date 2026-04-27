import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  listProjectDirectory,
  readProjectFile,
  replaceInProjectFile,
  resolveProjectToolPath,
  runProjectShellCommand,
  searchProjectFiles,
} from './tools'

async function withTempProject<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'airi-project-runner-'))
  try {
    return await fn(root)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('project runner tools', () => {
  it('rejects paths outside the project root', async () => {
    await withTempProject(async (root) => {
      expect(() => resolveProjectToolPath(root, '../outside.txt')).toThrow('Path escapes project root')
    })
  })

  it('lists, reads, searches, and patches project files', async () => {
    await withTempProject(async (root) => {
      await writeFile(join(root, 'task.txt'), 'hello AIRI\n')

      const entries = await listProjectDirectory({ projectRoot: root })
      const content = await readProjectFile({ projectRoot: root, relativePath: 'task.txt' })
      const matches = await searchProjectFiles({ projectRoot: root, query: 'AIRI' })
      const patched = await replaceInProjectFile({
        projectRoot: root,
        relativePath: 'task.txt',
        search: 'hello AIRI',
        replace: 'hello worker',
      })
      const nextContent = await readProjectFile({ projectRoot: root, relativePath: 'task.txt' })

      expect(entries).toEqual([{ path: 'task.txt', type: 'file' }])
      expect(content).toBe('hello AIRI\n')
      expect(matches).toEqual([{ path: 'task.txt', line: 1, text: 'hello AIRI' }])
      expect(patched.replacements).toBe(1)
      expect(nextContent).toBe('hello worker\n')
    })
  })

  it('blocks denied shell commands before spawning', async () => {
    await withTempProject(async (root) => {
      await expect(runProjectShellCommand({
        projectRoot: root,
        command: 'rm -rf dist',
        settings: {
          shellAllowlist: [],
          shellDenylist: ['rm'],
          timeoutMs: 1000,
        },
      })).rejects.toThrow('Command includes denied token: rm')
    })
  })
})
