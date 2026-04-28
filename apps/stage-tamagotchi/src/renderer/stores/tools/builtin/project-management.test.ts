import type { Project, WorkItem } from '@proj-airi/stage-projects'

import type {
  CreateProjectWorkItemPayload,
  CreateProjectWorkItemResult,
  DeleteProjectWorkItemPayload,
  ProjectManagementSnapshot,
  RegisterProjectPayload,
  StartProjectWorkItemPayload,
  StartProjectWorkItemResult,
  UpdateProjectWorkItemPayload,
} from '../../../../shared/eventa'
import type { ProjectManagementInvokers } from './project-management'

import { describe, expect, it, vi } from 'vitest'

import {
  executeProjectManagementAction,
  normalizeAcceptanceCriteria,
  projectManagementTools,
} from './project-management'

function createInvokers(snapshotOverride?: Partial<Pick<ProjectManagementSnapshot, 'projects' | 'workItems'>>): ProjectManagementInvokers {
  const registerProjectMock = vi.fn(async (payload: RegisterProjectPayload): Promise<Project> => ({
    id: 'project-1',
    name: 'demo',
    issuePrefix: payload.issuePrefix,
    rootPath: payload.rootPath,
    gitEnabled: true,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }))

  const createWorkItemMock = vi.fn(async (payload: CreateProjectWorkItemPayload): Promise<CreateProjectWorkItemResult> => ({
    duplicate: false,
    workItem: {
      id: 'work-1',
      projectId: payload.projectId,
      identifier: payload.identifier,
      title: payload.title,
      goal: payload.goal,
      acceptanceCriteria: payload.acceptanceCriteria,
      status: 'todo',
      position: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  }))

  const updateWorkItemMock = vi.fn(async (payload: UpdateProjectWorkItemPayload): Promise<WorkItem> => ({
    id: payload.id,
    projectId: 'project-1',
    identifier: 'AIRI-12',
    title: payload.patch.title ?? 'Add board',
    goal: payload.patch.goal ?? 'Show board',
    acceptanceCriteria: payload.patch.acceptanceCriteria ?? ['Done'],
    status: payload.patch.status ?? 'todo',
    position: 0,
    createdAt: 1,
    updatedAt: 2,
  }))

  const startWorkItemMock = vi.fn(async (payload: StartProjectWorkItemPayload): Promise<StartProjectWorkItemResult> => ({
    started: true,
    message: `${payload.identifier ?? payload.workItemId} 작업을 시작했어. 상태를 in_progress로 바꿨어.`,
  }))
  const deleteWorkItemMock = vi.fn(async (_payload: DeleteProjectWorkItemPayload): Promise<void> => {})

  return {
    getSnapshot: vi.fn(async (): Promise<ProjectManagementSnapshot> => ({
      projects: snapshotOverride?.projects ?? [{
        id: 'project-1',
        name: 'demo',
        issuePrefix: 'AIRI',
        rootPath: 'F:/workspace/demo',
        gitEnabled: true,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      }],
      workItems: snapshotOverride?.workItems ?? [{
        id: 'work-1',
        projectId: 'project-1',
        identifier: 'AIRI-12',
        title: 'Add board',
        goal: 'Show board',
        acceptanceCriteria: ['Done'],
        status: 'todo',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      }],
      comments: [],
      runs: [],
      settings: {
        projectManager: { provider: 'lm-studio', model: 'project-manager', systemPrompt: 'Project Manager' },
        worker: { provider: 'lm-studio', model: 'worker', systemPrompt: 'Worker' },
        reviewer: { provider: 'lm-studio', model: 'reviewer', systemPrompt: 'Reviewer' },
        maxReviewRetries: 5,
        maxConcurrentRuns: 2,
        autoCommit: true,
        shellDenylist: ['rm'],
        shellAllowlist: [],
        forbiddenPathPatterns: [],
        timeoutMs: 300000,
      },
    })),
    getBoardUrl: vi.fn(async () => ({ url: 'http://127.0.0.1:3000/project-board' })),
    openBoardExternal: vi.fn(async () => ({ opened: true, url: 'http://127.0.0.1:3000/project-board' })),
    registerProject: registerProjectMock,
    createWorkItem: createWorkItemMock,
    deleteWorkItem: deleteWorkItemMock,
    updateWorkItem: updateWorkItemMock,
    startWorkItem: startWorkItemMock,
  }
}

describe('project management built-in tool', () => {
  it('normalizes newline completion criteria', () => {
    expect(normalizeAcceptanceCriteria('A\n\nB')).toEqual(['A', 'B'])
    expect(normalizeAcceptanceCriteria([' A ', 'B'])).toEqual(['A', 'B'])
  })

  it('creates work items through Eventa invokers', async () => {
    const invokers = createInvokers()
    const result = await executeProjectManagementAction({
      action: 'create_work_item',
      projectId: 'project-1',
      identifier: 'AIRI-12',
      title: 'Add board',
      goal: 'Show board',
      acceptanceCriteria: 'Column exists',
      commitPrefix: 'AC-781',
    }, { invokers })

    expect(result).toContain('Created work item AIRI-12')
    expect(invokers.createWorkItem).toHaveBeenCalledWith({
      projectId: 'project-1',
      identifier: 'AIRI-12',
      title: 'Add board',
      goal: 'Show board',
      acceptanceCriteria: ['Column exists'],
      commitPrefix: 'AC-781',
      allowDuplicateIdentifier: false,
    })
  })

  it('uses the only registered project when creating a work item from chat', async () => {
    const invokers = createInvokers()
    const result = await executeProjectManagementAction({
      action: 'create_work_item',
      identifier: 'AIRI-13',
      title: 'Change page theme',
      goal: 'Make the default, dark, and light page backgrounds readable.',
      acceptanceCriteria: 'Background and text colors are readable in every theme.',
    }, { invokers })

    expect(result).toContain('Created work item AIRI-13')
    expect(invokers.createWorkItem).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      identifier: 'AIRI-13',
    }))
  })

  it('auto-generates the next project-prefixed identifier when creating a work item from chat', async () => {
    const invokers = createInvokers({
      projects: [{
        id: 'project-1',
        name: 'BriefWave-Cast',
        issuePrefix: 'BC',
        rootPath: 'F:/workspace/BriefWave-Cast',
        gitEnabled: true,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      }],
      workItems: [{
        id: 'work-1',
        projectId: 'project-1',
        identifier: 'BC-1',
        title: 'Existing',
        goal: 'Existing goal',
        acceptanceCriteria: ['Done'],
        status: 'todo',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      }],
    })
    const result = await executeProjectManagementAction({
      action: 'create_work_item',
      title: 'Change page theme',
      goal: 'Make the default, dark, and light page backgrounds readable.',
      acceptanceCriteria: 'Background and text colors are readable in every theme.',
    }, { invokers })

    expect(result).toContain('Created work item BC-2')
    expect(invokers.createWorkItem).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      identifier: 'BC-2',
    }))
  })

  it('asks for missing creation fields instead of throwing tool errors', async () => {
    const invokers = createInvokers()
    const result = await executeProjectManagementAction({
      action: 'create_work_item',
      projectId: null,
      identifier: null,
      title: 'Change page theme',
      goal: 'Make theme colors readable.',
      acceptanceCriteria: null,
    }, { invokers })

    expect(result).toContain('완료 조건')
    expect(invokers.createWorkItem).not.toHaveBeenCalled()
  })

  it('starts a TODO work item through Eventa invokers', async () => {
    const invokers = createInvokers()
    const result = await executeProjectManagementAction({
      action: 'start_work_item',
      identifier: 'AIRI-12',
    }, { invokers })

    expect(result).toContain('AIRI-12 작업을 시작')
    expect(invokers.startWorkItem).toHaveBeenCalledWith({
      allowDirtyWorktree: false,
      identifier: 'AIRI-12',
      workItemId: undefined,
    })
  })

  it('deletes a work item through Eventa invokers', async () => {
    const invokers = createInvokers()
    const result = await executeProjectManagementAction({
      action: 'delete_work_item',
      workItemId: 'work-1',
    }, { invokers })

    expect(result).toContain('Deleted work item work-1')
    expect(invokers.deleteWorkItem).toHaveBeenCalledWith({ id: 'work-1' })
  })

  it('lists work items filtered by status', async () => {
    const invokers = createInvokers({
      workItems: [
        {
          id: 'work-1',
          projectId: 'project-1',
          identifier: 'AIRI-12',
          title: 'Add board',
          goal: 'Show board',
          acceptanceCriteria: ['Done'],
          status: 'todo',
          position: 0,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'work-2',
          projectId: 'project-1',
          identifier: 'AIRI-13',
          title: 'Done thing',
          goal: 'Done',
          acceptanceCriteria: ['Done'],
          status: 'done',
          position: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    const result = await executeProjectManagementAction({
      action: 'list_work_items',
      status: 'todo',
    }, { invokers })

    expect(result).toContain('AIRI-12')
    expect(result).not.toContain('AIRI-13')
  })

  it('exposes a provider-safe strict object schema', async () => {
    const tools = await projectManagementTools()
    const tool = tools.find(item => item.function.name === 'stage_project_management')

    expect(tool?.function.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
    })
    expect(tool?.function.parameters.required).toContain('action')
    expect(tool?.function.parameters.required).toContain('status')
  })
})
