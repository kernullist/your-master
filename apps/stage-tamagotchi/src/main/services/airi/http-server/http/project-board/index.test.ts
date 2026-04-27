import { describe, expect, it, vi } from 'vitest'

import { createProjectBoardServer, renderProjectBoardHtml } from './index'

describe('project board server', () => {
  it('renders the board shell with snapshot loading script', () => {
    const html = renderProjectBoardHtml()

    expect(html).toContain('Project Board')
    expect(html).toContain('New project')
    expect(html).toContain('Projects')
    expect(html).toContain('data-project-select')
    expect(html).toContain('New work item')
    expect(html).toContain('Commit prefix')
    expect(html).toContain('Branch · ')
    expect(html).toContain('Worktree · ')
    expect(html).toContain('id="projects"')
    expect(html).toContain('project.rootPath')
    expect(html).toContain('/project-board/api/snapshot')
    expect(html).toContain('/project-board/api/events')
    expect(html).toContain('/project-board/api/projects')
    expect(html).toContain('EventSource')
    expect(html).toContain('/project-board/api/work-items')
    expect(html).toContain('PATCH')
    expect(html).toContain('DELETE')
    expect(html).toContain('data-action="delete"')
    expect(html).not.toContain('data-project-open')
    expect(html).not.toContain('data-action="review"')
    expect(html).toContain('todo')
  })

  it('exposes a board URL after start', async () => {
    const server = createProjectBoardServer({
      store: {
        getSnapshot: () => ({
          projects: [],
          workItems: [],
          comments: [],
          runs: [],
          settings: {
            airi: { provider: 'lm-studio', model: '', systemPrompt: 'AIRI' },
            worker: { provider: 'lm-studio', model: '', systemPrompt: 'Worker' },
            reviewer: { provider: 'lm-studio', model: '', systemPrompt: 'Reviewer' },
            maxReviewRetries: 5,
            maxConcurrentRuns: 2,
            autoCommit: true,
            shellDenylist: ['rm'],
            shellAllowlist: [],
            forbiddenPathPatterns: [],
            timeoutMs: 300000,
          },
        }),
        updateWorkItem: vi.fn(() => {
          throw new Error('not used')
        }),
        createWorkItem: vi.fn(() => {
          throw new Error('not used')
        }),
        deleteProject: vi.fn(() => {
          throw new Error('not used')
        }),
        deleteWorkItem: vi.fn(() => {
          throw new Error('not used')
        }),
        registerProject: vi.fn(() => {
          throw new Error('not used')
        }),
        subscribeSnapshot: vi.fn(() => () => {}),
      },
      registerEventa: false,
    })

    await server.start()
    try {
      expect(server.getBoardUrl()).toContain('/project-board')
    }
    finally {
      await server.stop()
    }
  })
})
