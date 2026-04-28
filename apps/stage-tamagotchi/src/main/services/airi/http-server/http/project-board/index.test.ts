import { describe, expect, it, vi } from 'vitest'

import { createProjectBoardServer, renderProjectBoardHtml } from './index'

describe('project board server', () => {
  it('renders the board shell with snapshot loading script', () => {
    const html = renderProjectBoardHtml()

    expect(html).toContain('Project Board')
    expect(html).toContain('Your Master workspace')
    expect(html).toContain('New project')
    expect(html).toContain('Projects')
    expect(html).toContain('data-project-select')
    expect(html).toContain('data-project-delete')
    expect(html).toContain('project-delete')
    expect(html).toContain('New work item')
    expect(html).toContain('Search title, identifier, goal, commit prefix')
    expect(html).not.toContain('All priorities')
    expect(html).not.toContain('priority-pill')
    expect(html).toContain('Hide done')
    expect(html).toContain('progress-fill')
    expect(html).toContain('rail-summary')
    expect(html).toContain('Project health')
    expect(html).toContain('Focus')
    expect(html).toContain('Next up')
    expect(html).toContain('data-view="list"')
    expect(html).toContain('list-view')
    expect(html).toContain('Commit prefix')
    expect(html).toContain('Branch · ')
    expect(html).toContain('Worktree · ')
    expect(html).toContain('selectedProjectMetrics')
    expect(html).toContain('statusLabels')
    expect(html).toContain('escapeHtml(item.goal)')
    expect(html).toContain('escapeHtml(comment.content)')
    expect(html).toContain('id="projects"')
    expect(html).toContain('project.rootPath')
    expect(html).toContain('/project-board/api/snapshot')
    expect(html).toContain('/project-board/api/events')
    expect(html).toContain('/project-board/api/projects')
    expect(html).toContain('EventSource')
    expect(html).toContain('/project-board/api/work-items')
    expect(html).toContain('/project-board/api/work-items/\' + encodeURIComponent(id) + \'/start')
    expect(html).toContain('PATCH')
    expect(html).toContain('DELETE')
    expect(html).toContain('data-action="delete"')
    expect(html).toContain('item.status === \'todo\'')
    expect(html).not.toContain('data-project-open')
    expect(html).not.toContain('data-action="review"')
    expect(html).toContain('todo')
  })

  it('starts work items through the runner-backed board endpoint', async () => {
    const startWorkItem = vi.fn(async () => ({
      started: true,
      message: 'started',
    }))
    const server = createProjectBoardServer({
      store: {
        getSnapshot: () => ({
          projects: [],
          workItems: [],
          comments: [],
          runs: [],
          settings: {
            projectManager: { provider: 'lm-studio', model: '', systemPrompt: 'Project Manager' },
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
        startWorkItem,
        subscribeSnapshot: vi.fn(() => () => {}),
      },
      registerEventa: false,
    })

    await server.start()
    try {
      const response = await fetch(`${server.getBoardUrl()}/api/work-items/work-1/start`, {
        method: 'POST',
      })
      const result = await response.json()

      expect(response.ok).toBe(true)
      expect(result).toEqual({
        started: true,
        message: 'started',
      })
      expect(startWorkItem).toHaveBeenCalledWith({ workItemId: 'work-1' })
    }
    finally {
      await server.stop()
    }
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
            projectManager: { provider: 'lm-studio', model: '', systemPrompt: 'Project Manager' },
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
        startWorkItem: vi.fn(() => {
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
