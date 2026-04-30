import type { Project, WorkItem } from '@proj-airi/stage-projects'

import type { ProjectManagementSnapshot } from '../../../../shared/eventa/project-management'

import { defaultProjectAgentSettings } from '@proj-airi/stage-projects'
import { describe, expect, it } from 'vitest'

import { createProjectDashboardViewModel } from './project-dashboard-model'

const project: Project = {
  id: 'project-1',
  name: 'AIRI',
  issuePrefix: 'AIRI',
  rootPath: 'project-root',
  gitEnabled: true,
  metadata: {},
  createdAt: 0,
  updatedAt: 0,
}

function createWorkItem(id: string, updatedAt: number): WorkItem {
  return {
    id,
    projectId: project.id,
    identifier: `AIRI-${id}`,
    title: `Work item ${id}`,
    goal: 'Keep the project dashboard deterministic.',
    acceptanceCriteria: ['The dashboard groups work from the injected clock.'],
    status: 'todo',
    position: 0,
    createdAt: updatedAt,
    updatedAt,
  }
}

function createSnapshot(workItems: WorkItem[]): ProjectManagementSnapshot {
  return {
    projects: [project],
    workItems,
    comments: [],
    runs: [],
    settings: defaultProjectAgentSettings,
  }
}

/**
 * @example
 * describe('createProjectDashboardViewModel', () => {})
 */
describe('createProjectDashboardViewModel', () => {
  /**
   * @example
   * it('uses the injected clock for activity columns', () => {})
   */
  it('uses the injected clock for activity columns', () => {
    const now = Date.UTC(2026, 0, 10, 12)
    const twoDaysAgo = now - 2 * 86_400_000
    const viewModel = createProjectDashboardViewModel({
      snapshot: createSnapshot([createWorkItem('1', twoDaysAgo)]),
      selectedProjectId: null,
      selectedWorkItemId: null,
      query: '',
      filter: 'all',
      groupBy: 'activity',
      now,
    })

    // ROOT CAUSE:
    //
    // If activity grouping calls Date.now() directly, injected test clocks and the
    // dashboard's minute timer disagree. A two-day-old card can jump into an
    // unrelated bucket whenever real wall time has moved far from `now`.
    //
    // We fixed this by carrying the same `now` value through filtering, metrics,
    // and activity grouping.
    //
    // @example expect(weekGroup?.cards.map(card => card.item.id)).toEqual(['1'])
    const weekGroup = viewModel.groups.find(group => group.id === 'activity:week')
    expect(weekGroup?.cards.map(card => card.item.id)).toEqual(['1'])

    // @example expect(todayGroup?.cards).toHaveLength(0)
    const todayGroup = viewModel.groups.find(group => group.id === 'activity:today')
    expect(todayGroup?.cards).toHaveLength(0)
  })

  /**
   * @example
   * it('returns fresh empty metric objects', () => {})
   */
  it('returns fresh empty metric objects', () => {
    const input = {
      snapshot: createSnapshot([]),
      selectedProjectId: null,
      selectedWorkItemId: null,
      query: '',
      filter: 'all' as const,
      groupBy: 'status' as const,
      now: Date.UTC(2026, 0, 10, 12),
    }

    const first = createProjectDashboardViewModel(input)
    const second = createProjectDashboardViewModel(input)

    first.metrics.statusSegments[0].count = 99

    // @example expect(second.metrics).not.toBe(first.metrics)
    expect(second.metrics).not.toBe(first.metrics)
    // @example expect(second.metrics.statusSegments[0].count).toBe(0)
    expect(second.metrics.statusSegments[0].count).toBe(0)
  })
})
