import type { WorkItem, WorkItemStatus } from '../types/work-item.ts'

export const WORK_ITEM_STATUSES: WorkItemStatus[] = ['todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled']

export const ACTIVE_WORK_ITEM_STATUSES: WorkItemStatus[] = ['todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled']

const statusOrder = new Map(WORK_ITEM_STATUSES.map((status, index) => [status, index]))

/**
 * Groups work items by board status.
 *
 * Use when:
 * - The board needs stable columns even when some statuses have no items
 *
 * Expects:
 * - Work item positions are finite numbers
 *
 * Returns:
 * - A status-keyed record with items sorted by position and identifier
 */
export function groupWorkItemsByStatus(items: WorkItem[]): Record<WorkItemStatus, WorkItem[]> {
  const groups: Record<WorkItemStatus, WorkItem[]> = {
    todo: [],
    in_progress: [],
    in_review: [],
    done: [],
    blocked: [],
    cancelled: [],
  }
  for (const item of items) {
    groups[item.status].push(item)
  }

  for (const status of WORK_ITEM_STATUSES) {
    groups[status].sort((a, b) => a.position - b.position || a.identifier.localeCompare(b.identifier))
  }

  return groups
}

/**
 * Sorts work items in board order.
 *
 * Use when:
 * - A flat list should match the visual board order
 *
 * Expects:
 * - Unknown statuses are impossible by type
 *
 * Returns:
 * - A new sorted array
 */
export function sortWorkItemsForBoard(items: WorkItem[]): WorkItem[] {
  return [...items].sort((a, b) => {
    return (statusOrder.get(a.status) ?? 0) - (statusOrder.get(b.status) ?? 0)
      || a.position - b.position
      || a.identifier.localeCompare(b.identifier)
  })
}

/**
 * Resolves the next workflow status when runner ownership changes.
 *
 * Use when:
 * - Worker/reviewer execution changes the card state
 *
 * Expects:
 * - `event` is emitted by the local project runner
 *
 * Returns:
 * - The status AIRI should persist on the work item
 */
export function statusForRunnerEvent(event: 'start-worker' | 'start-review' | 'request-changes' | 'pass-review' | 'block' | 'cancel'): WorkItemStatus {
  switch (event) {
    case 'start-worker':
    case 'request-changes':
      return 'in_progress'
    case 'start-review':
      return 'in_review'
    case 'pass-review':
      return 'done'
    case 'block':
      return 'blocked'
    case 'cancel':
      return 'cancelled'
  }
}
