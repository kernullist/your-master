import type { Project, WorkItem, WorkItemComment, WorkItemRunRecord } from '@proj-airi/stage-projects'

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  buildProjectRunnerContextPack,
  distillFailureMemory,
  formatProjectRunnerContextPack,
} from './context-pack'

async function withTempProject<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'airi-project-context-'))
  try {
    return await fn(root)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('distillFailureMemory', () => {
  it('drops blanks, collapses near-duplicates, and caps entry length and count', () => {
    const distilled = distillFailureMemory([
      'run status=blocked; error=X',
      '  run status=blocked;   error=X  ', // same as above after whitespace/case normalization
      '   ',
      `long ${'y'.repeat(400)}`,
    ], 12, 300)

    // The duplicate collapses to one entry; the blank is dropped.
    expect(distilled).toHaveLength(2)
    expect(distilled[0]).toBe('run status=blocked; error=X')
    // The long entry is truncated with a marker.
    expect(distilled[1].endsWith(' ...')).toBe(true)
    expect(distilled[1].length).toBe(304)
  })

  it('caps the number of retained lessons', () => {
    const entries = Array.from({ length: 20 }, (_, index) => `failure ${index}`)
    expect(distillFailureMemory(entries, 5)).toHaveLength(5)
  })
})

describe('project runner context pack', () => {
  it('collects file, test, related work, and failure memory context', async () => {
    await withTempProject(async (root) => {
      await writeFile(join(root, 'package.json'), JSON.stringify({
        scripts: {
          test: 'vitest run',
        },
      }))
      await writeFile(join(root, 'src.ts'), 'export const value = 1\n')

      const project: Project = {
        id: 'project-1',
        name: 'demo',
        issuePrefix: 'AIRI',
        rootPath: root,
        gitEnabled: false,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      }
      const workItem: WorkItem = {
        id: 'work-1',
        projectId: project.id,
        identifier: 'AIRI-12',
        title: 'Make worker smarter',
        goal: 'Improve worker context',
        acceptanceCriteria: ['Context is visible'],
        status: 'todo',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      const comments: WorkItemComment[] = [{
        id: 'comment-1',
        workItemId: workItem.id,
        actorType: 'reviewer',
        kind: 'review',
        content: 'failed because tests were missing',
        createdAt: 3,
      }]
      const runs: WorkItemRunRecord[] = [{
        id: 'run-1',
        workItemId: workItem.id,
        status: 'blocked',
        attempt: 2,
        changedFiles: ['src.ts'],
        error: 'review failed',
        startedAt: 1,
        finishedAt: 2,
      }]

      const pack = await buildProjectRunnerContextPack({
        forbiddenPathPatterns: [],
        project,
        projectRoot: root,
        source: {
          workItems: [{ ...workItem, id: 'work-2', identifier: 'AIRI-13', title: 'Related', position: 1 }],
          comments,
          runs,
        },
        workItem,
      })
      const formatted = formatProjectRunnerContextPack(pack)

      expect(pack.packageScripts).toEqual([{ name: 'test', command: 'vitest run' }])
      expect(pack.recommendedTests[0]?.command).toBe('npm run test')
      expect(pack.relatedWorkItems[0]?.identifier).toBe('AIRI-13')
      expect(pack.failureMemory.some(item => item.includes('failed'))).toBe(true)
      expect(formatted).toContain('Failure memory')
    })
  })

  it('does not treat missing package.json or successful tests as failure context', async () => {
    await withTempProject(async (root) => {
      await writeFile(join(root, 'Cargo.toml'), '[package]\nname = "demo"\n')
      const project: Project = {
        id: 'project-1',
        name: 'demo',
        issuePrefix: 'AIRI',
        rootPath: root,
        gitEnabled: false,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      }
      const workItem: WorkItem = {
        id: 'work-1',
        projectId: project.id,
        identifier: 'AIRI-15',
        title: 'Keep memory focused',
        goal: 'Avoid noisy context',
        acceptanceCriteria: ['Only failure-like notes are remembered'],
        status: 'todo',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      }

      // ROOT CAUSE:
      //
      // Missing package.json previously raised a context warning for non-Node
      // projects, and any stored testSummary was copied into failureMemory.
      // That made Rust/Go/Python projects look partially broken and taught the
      // worker from successful test runs.
      //
      // We fixed this by treating absent package.json as normal and only adding
      // failure-like test/review text to failureMemory.
      const pack = await buildProjectRunnerContextPack({
        forbiddenPathPatterns: [],
        project,
        projectRoot: root,
        source: {
          runs: [{
            id: 'run-1',
            workItemId: workItem.id,
            status: 'done',
            attempt: 1,
            changedFiles: ['src/lib.rs'],
            testSummary: 'Command: cargo test\nExit code: 0\nTimed out: false',
            startedAt: 1,
            finishedAt: 2,
          }],
        },
        workItem,
      })

      expect(pack.packageScripts).toEqual([])
      expect(pack.warnings).toEqual([])
      expect(pack.recommendedTests[0]?.command).toBe('cargo test')
      expect(pack.failureMemory).toEqual([])
    })
  })
})
