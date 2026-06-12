import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  buildAgentRunWorktreeBranchName,
  buildAgentRunWorktreePath,
  buildAgentWorktreeBranchName,
  buildAgentWorktreePath,
  buildWorkItemCommitMessage,
  commitAgentChangedFiles,
  createAgentWorktree,
  getGitChangedFiles,
  integrateAgentBranchIntoProject,
  removeAgentWorktree,
  revertAgentChangedFiles,
  runGit,
} from './git'

async function withGitProject<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'airi-project-git-'))
  try {
    await runGit(root, ['init'])
    await runGit(root, ['config', 'user.email', 'airi@example.test'])
    await runGit(root, ['config', 'user.name', 'AIRI'])
    await writeFile(join(root, 'agent.txt'), 'before\n')
    await writeFile(join(root, 'user.txt'), 'user\n')
    await runGit(root, ['add', 'agent.txt', 'user.txt'])
    await runGit(root, ['commit', '-m', 'chore: initial'])
    return await fn(root)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('project runner git helpers', () => {
  it('builds work item commit messages with identifiers', () => {
    expect(buildWorkItemCommitMessage({
      identifier: 'AIRI-12',
      title: 'Add project board',
    })).toBe('feat: add project board (AIRI-12)')
  })

  it('prepends external commit prefixes to automatic commit messages', () => {
    expect(buildWorkItemCommitMessage({
      commitPrefix: 'AC-781',
      identifier: 'BC-1',
      title: 'Change page theme',
    })).toBe('AC-781 [feat] change page theme (BC-1)')
  })

  it('builds deterministic agent worktree names', async () => {
    await withGitProject(async (root) => {
      const workItem = {
        identifier: 'AIRI-12',
      }

      expect(buildAgentWorktreeBranchName(workItem)).toBe('airi/work/airi-12')
      expect(buildAgentWorktreePath(root, workItem).replace(/\\/g, '/')).toContain('/.airi-worktrees/')
      expect(buildAgentWorktreePath(root, workItem).replace(/\\/g, '/')).toContain('/airi-12')
      expect(buildAgentRunWorktreeBranchName(workItem, 'run-1')).toBe('airi/work/airi-12/run-1')
      expect(buildAgentRunWorktreePath(root, workItem, 'run-1').replace(/\\/g, '/')).toContain('/airi-12/run-1')
    })
  }, 15000)

  it('commits agent changes inside an isolated worktree branch', async () => {
    await withGitProject(async (root) => {
      const worktree = await createAgentWorktree({
        projectRoot: root,
        workItem: {
          identifier: 'AIRI-12',
        },
      })

      try {
        await writeFile(join(worktree.path, 'agent.txt'), 'after in worktree\n')
        const result = await commitAgentChangedFiles({
          projectRoot: worktree.path,
          files: ['agent.txt'],
          workItem: {
            identifier: 'AIRI-12',
            title: 'Add project board',
          },
        })
        const originalFile = await readFile(join(root, 'agent.txt'), 'utf-8')
        const originalStatus = await runGit(root, ['status', '--porcelain'])
        const worktreeBranch = await runGit(worktree.path, ['branch', '--show-current'])

        expect(result.committed).toBe(true)
        expect(worktree.branchName).toBe('airi/work/airi-12')
        expect(worktreeBranch.stdout.trim()).toBe('airi/work/airi-12')
        expect(originalFile.replace(/\r\n/g, '\n')).toBe('before\n')
        expect(originalStatus.stdout.trim()).toBe('')
      }
      finally {
        await removeAgentWorktree(root, worktree.path)
      }
    })
  }, 15000)

  it('commits only agent-changed files', async () => {
    await withGitProject(async (root) => {
      await writeFile(join(root, 'agent.txt'), 'after\n')
      await writeFile(join(root, 'user.txt'), 'user local change\n')

      const result = await commitAgentChangedFiles({
        projectRoot: root,
        files: ['agent.txt'],
        workItem: {
          identifier: 'AIRI-12',
          title: 'Add project board',
        },
      })
      const status = await runGit(root, ['status', '--porcelain'])

      expect(result.committed).toBe(true)
      expect(result.message).toBe('feat: add project board (AIRI-12)')
      expect(status.stdout).toContain(' M user.txt')
      expect(status.stdout).not.toContain('agent.txt')
    })
  }, 15000)

  it('detects changed files from git status porcelain', async () => {
    await withGitProject(async (root) => {
      await writeFile(join(root, 'agent.txt'), 'after\n')
      await writeFile(join(root, 'created.txt'), 'new\n')

      const files = await getGitChangedFiles(root)

      expect(files).toEqual(['agent.txt', 'created.txt'])
    })
  }, 15000)

  it('reverts only agent-changed files', async () => {
    await withGitProject(async (root) => {
      await writeFile(join(root, 'agent.txt'), 'after\n')
      await writeFile(join(root, 'user.txt'), 'user local change\n')

      const result = await revertAgentChangedFiles(root, ['agent.txt'])
      const agentFile = await readFile(join(root, 'agent.txt'), 'utf-8')
      const userFile = await readFile(join(root, 'user.txt'), 'utf-8')

      expect(result.exitCode).toBe(0)
      expect(agentFile.replace(/\r\n/g, '\n')).toBe('before\n')
      expect(userFile.replace(/\r\n/g, '\n')).toBe('user local change\n')
    })
  }, 15000)

  it('preserves a conflicting agent branch when another completed branch was integrated first', async () => {
    await withGitProject(async (root) => {
      const firstWorktree = await createAgentWorktree({
        projectRoot: root,
        workItem: {
          identifier: 'AIRI-12',
        },
        branchName: 'airi/work/airi-12/run-first',
      })
      const secondWorktree = await createAgentWorktree({
        projectRoot: root,
        workItem: {
          identifier: 'AIRI-13',
        },
        branchName: 'airi/work/airi-13/run-second',
      })

      try {
        await writeFile(join(firstWorktree.path, 'agent.txt'), 'after first agent\n')
        await writeFile(join(secondWorktree.path, 'agent.txt'), 'after second agent\n')

        const firstCommit = await commitAgentChangedFiles({
          projectRoot: firstWorktree.path,
          files: ['agent.txt'],
          workItem: {
            identifier: 'AIRI-12',
            title: 'Update first agent text',
          },
        })
        const secondCommit = await commitAgentChangedFiles({
          projectRoot: secondWorktree.path,
          files: ['agent.txt'],
          workItem: {
            identifier: 'AIRI-13',
            title: 'Update second agent text',
          },
        })
        const firstIntegration = await integrateAgentBranchIntoProject({
          projectRoot: root,
          branchName: firstWorktree.branchName,
        })
        const secondIntegration = await integrateAgentBranchIntoProject({
          projectRoot: root,
          branchName: secondWorktree.branchName,
        })
        const originalFile = await readFile(join(root, 'agent.txt'), 'utf-8')
        const secondBranchFile = await runGit(root, ['show', `${secondWorktree.branchName}:agent.txt`])
        const status = await runGit(root, ['status', '--porcelain'])

        expect(firstCommit.committed).toBe(true)
        expect(secondCommit.committed).toBe(true)
        expect(firstIntegration.integrated).toBe(true)
        expect(secondIntegration.integrated).toBe(false)
        expect(secondIntegration.conflict).toBe(true)
        expect(originalFile.replace(/\r\n/g, '\n')).toBe('after first agent\n')
        expect(secondBranchFile.stdout.replace(/\r\n/g, '\n')).toBe('after second agent\n')
        expect(status.stdout.trim()).toBe('')
      }
      finally {
        await removeAgentWorktree(root, firstWorktree.path)
        await removeAgentWorktree(root, secondWorktree.path)
      }
    })
  }, 15000)

  it('treats already-applied agent branch changes as integrated', async () => {
    await withGitProject(async (root) => {
      const firstWorktree = await createAgentWorktree({
        projectRoot: root,
        workItem: {
          identifier: 'AIRI-12',
        },
        branchName: 'airi/work/airi-12/run-first',
      })
      const secondWorktree = await createAgentWorktree({
        projectRoot: root,
        workItem: {
          identifier: 'AIRI-13',
        },
        branchName: 'airi/work/airi-13/run-second',
      })

      try {
        await writeFile(join(firstWorktree.path, 'agent.txt'), 'same accepted change\n')
        await writeFile(join(secondWorktree.path, 'agent.txt'), 'same accepted change\n')

        const firstCommit = await commitAgentChangedFiles({
          projectRoot: firstWorktree.path,
          files: ['agent.txt'],
          workItem: {
            identifier: 'AIRI-12',
            title: 'Apply shared agent text',
          },
        })
        const secondCommit = await commitAgentChangedFiles({
          projectRoot: secondWorktree.path,
          files: ['agent.txt'],
          workItem: {
            identifier: 'AIRI-13',
            title: 'Apply shared agent text again',
          },
        })
        const firstIntegration = await integrateAgentBranchIntoProject({
          projectRoot: root,
          branchName: firstWorktree.branchName,
        })
        const secondIntegration = await integrateAgentBranchIntoProject({
          projectRoot: root,
          branchName: secondWorktree.branchName,
        })
        const status = await runGit(root, ['status', '--porcelain'])

        expect(firstCommit.committed).toBe(true)
        expect(secondCommit.committed).toBe(true)
        expect(firstIntegration.integrated).toBe(true)
        expect(secondIntegration.integrated).toBe(true)
        expect(secondIntegration.conflict).toBe(false)
        expect(secondIntegration.skipped).toBe(true)
        expect(status.stdout.trim()).toBe('')
      }
      finally {
        await removeAgentWorktree(root, firstWorktree.path)
        await removeAgentWorktree(root, secondWorktree.path)
      }
    })
  }, 15000)
})
