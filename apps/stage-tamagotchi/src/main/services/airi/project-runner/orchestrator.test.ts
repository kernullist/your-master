import type { Project, WorkItem, WorkItemRunRecord } from '@proj-airi/stage-projects'

import type { AgentRuntimeFetch } from './agent-runtime'

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultProjectAgentSettings } from '@proj-airi/stage-projects'
import { describe, expect, it, vi } from 'vitest'

import { runGit } from './git'
import { runProjectWorkItem } from './orchestrator'

async function withGitProject<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'airi-project-orchestrator-'))
  try {
    await runGit(root, ['init'])
    await runGit(root, ['config', 'user.email', 'airi@example.test'])
    await runGit(root, ['config', 'user.name', 'AIRI'])
    await writeFile(join(root, 'agent.txt'), 'before\n')
    await runGit(root, ['add', 'agent.txt'])
    await runGit(root, ['commit', '-m', 'chore: initial'])
    return await fn(root)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

function createAgentResponse(content: string) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content } }],
    }),
  }
}

describe('project work item orchestrator', () => {
  it('runs worker edits, review, and commit inside an isolated worktree branch', async () => {
    await withGitProject(async (root) => {
      const project: Project = {
        id: 'project-1',
        name: 'demo',
        issuePrefix: 'AIRI',
        rootPath: root,
        gitEnabled: true,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      }
      const workItem: WorkItem = {
        id: 'work-1',
        projectId: project.id,
        identifier: 'AIRI-12',
        title: 'Update agent text',
        goal: 'Change the agent text file',
        acceptanceCriteria: ['agent.txt says after'],
        status: 'todo',
        priority: 'none',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      const comments: Array<{ actorType: string, content: string, kind: string, workItemId: string }> = []
      const runs: WorkItemRunRecord[] = []
      const statuses: WorkItem['status'][] = []
      const responses = [
        createAgentResponse(JSON.stringify({ action: 'read', path: 'agent.txt' })),
        createAgentResponse(JSON.stringify({ action: 'replace', path: 'agent.txt', search: 'before', replace: 'after' })),
        createAgentResponse(JSON.stringify({ action: 'final', comment: 'Updated agent.txt' })),
        createAgentResponse(JSON.stringify({ passed: true, comment: 'Looks good' })),
      ]
      const fetcher: AgentRuntimeFetch = vi.fn(async () => responses.shift() ?? createAgentResponse(JSON.stringify({ action: 'final', comment: 'done' })))

      await runProjectWorkItem({
        fetcher,
        generateId: () => 'run-1',
        now: () => 1000,
        project,
        settings: {
          ...defaultProjectAgentSettings,
          autoCommit: true,
        },
        store: {
          addComment: payload => comments.push(payload),
          updateWorkItem: (payload) => {
            statuses.push(payload.patch.status)
            return { ...workItem, status: payload.patch.status }
          },
          upsertRunRecord: (run) => {
            runs.push(run)
            return run
          },
        },
        workItem,
      })

      const originalFile = await readFile(join(root, 'agent.txt'), 'utf-8')
      const branchFile = await runGit(root, ['show', 'airi/work/airi-12:agent.txt'])
      const status = await runGit(root, ['status', '--porcelain'])

      expect(originalFile.replace(/\r\n/g, '\n')).toBe('before\n')
      expect(branchFile.stdout.replace(/\r\n/g, '\n')).toBe('after\n')
      expect(status.stdout.trim()).toBe('')
      expect(statuses).toEqual(['in_progress', 'in_review', 'done'])
      expect(comments.some(comment => comment.content.includes('worktree'))).toBe(true)
      expect(comments.some(comment => comment.kind === 'commit' && comment.content.includes('자동 커밋 완료'))).toBe(true)
      expect(runs.at(-1)?.status).toBe('done')
      expect(runs.at(-1)?.branchName).toBe('airi/work/airi-12')
    })
  }, 30000)
})
