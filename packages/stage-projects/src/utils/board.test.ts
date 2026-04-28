import type { WorkItem } from '../types/work-item.ts'

import { describe, expect, it } from 'vitest'

import { groupWorkItemsByStatus, sortWorkItemsForBoard, statusForRunnerEvent } from './board.ts'

function item(id: string, status: WorkItem['status'], position: number): WorkItem {
  return {
    id,
    projectId: 'project-1',
    identifier: `AIRI-${id}`,
    title: id,
    goal: 'Goal',
    acceptanceCriteria: ['Done'],
    status,
    position,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('groupWorkItemsByStatus', () => {
  it('groups every status and sorts by position', () => {
    const grouped = groupWorkItemsByStatus([
      item('2', 'todo', 2),
      item('1', 'todo', 1),
      item('3', 'done', 1),
    ])

    expect(grouped.todo.map(entry => entry.id)).toEqual(['1', '2'])
    expect(grouped.done.map(entry => entry.id)).toEqual(['3'])
    expect(grouped.blocked).toEqual([])
  })
})

describe('sortWorkItemsForBoard', () => {
  it('sorts by status order and position', () => {
    const sorted = sortWorkItemsForBoard([
      item('3', 'done', 1),
      item('2', 'todo', 2),
      item('1', 'todo', 1),
    ])

    expect(sorted.map(entry => entry.id)).toEqual(['1', '2', '3'])
  })
})

describe('statusForRunnerEvent', () => {
  it('maps worker and reviewer events to work item statuses', () => {
    expect(statusForRunnerEvent('start-worker')).toBe('in_progress')
    expect(statusForRunnerEvent('start-review')).toBe('in_review')
    expect(statusForRunnerEvent('request-changes')).toBe('in_progress')
    expect(statusForRunnerEvent('pass-review')).toBe('done')
    expect(statusForRunnerEvent('block')).toBe('blocked')
  })
})
