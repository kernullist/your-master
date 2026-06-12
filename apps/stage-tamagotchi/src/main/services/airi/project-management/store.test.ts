import type { ProjectAgentSettings, WorkItem, WorkItemStatus } from '@proj-airi/stage-projects'

import type { ProjectManagementState } from './store'

import { describe, expect, it } from 'vitest'

import {
  createDefaultProjectManagementState,
  createProjectManagementStore,
  mergeProjectAgentSettings,
} from './store'

function createTestStore() {
  let id = 0
  const saved: ProjectManagementState[] = []
  const statusChanges: Array<{ workItem: WorkItem, previousStatus: WorkItemStatus }> = []

  const store = createProjectManagementStore(createDefaultProjectManagementState(), {
    generateId: () => `id-${++id}`,
    now: () => 1000 + id,
    save: state => saved.push(state),
    notifyStatusChange: (workItem, previousStatus) => statusChanges.push({ workItem, previousStatus }),
  })

  return {
    saved,
    statusChanges,
    store,
  }
}

describe('project management store', () => {
  it('registers projects and creates work items with normalized identifiers', () => {
    const { saved, store } = createTestStore()
    const project = store.registerProject({
      rootPath: 'F:/workspace/my-app',
      issuePrefix: 'airi',
      gitEnabled: true,
    })

    const created = store.createWorkItem({
      projectId: project.id,
      identifier: 'airi 12',
      title: 'Add board',
      goal: 'Show local work items',
      acceptanceCriteria: ['Board lists todo cards'],
    })

    expect(saved).toHaveLength(2)
    expect(project.name).toBe('my-app')
    expect(project.issuePrefix).toBe('AIRI')
    expect(created.duplicate).toBe(false)
    expect(created.workItem?.identifier).toBe('AIRI-12')
  })

  it('reports duplicate work item identifiers until confirmation is supplied', () => {
    const { store } = createTestStore()
    const project = store.registerProject({
      rootPath: 'F:/workspace/my-app',
      issuePrefix: 'AIRI',
      gitEnabled: true,
    })

    store.createWorkItem({
      projectId: project.id,
      identifier: 'AIRI-12',
      title: 'First',
      goal: 'First goal',
      acceptanceCriteria: ['Done'],
    })
    const blocked = store.createWorkItem({
      projectId: project.id,
      identifier: 'AIRI-12',
      title: 'Second',
      goal: 'Second goal',
      acceptanceCriteria: ['Done'],
    })
    const confirmed = store.createWorkItem({
      projectId: project.id,
      identifier: 'AIRI-12',
      title: 'Second',
      goal: 'Second goal',
      acceptanceCriteria: ['Done'],
      allowDuplicateIdentifier: true,
    })

    expect(blocked.duplicate).toBe(true)
    expect(blocked.existing?.title).toBe('First')
    expect(confirmed.duplicate).toBe(false)
  })

  it('emits status change notifications after work item updates', () => {
    const { statusChanges, store } = createTestStore()
    const project = store.registerProject({
      rootPath: 'F:/workspace/my-app',
      issuePrefix: 'AIRI',
      gitEnabled: true,
    })
    const created = store.createWorkItem({
      projectId: project.id,
      identifier: 'AIRI-12',
      title: 'Add board',
      goal: 'Show local work items',
      acceptanceCriteria: ['Board lists todo cards'],
    })

    store.updateWorkItem({
      id: created.workItem!.id,
      patch: { status: 'in_progress' },
    })

    expect(statusChanges).toHaveLength(1)
    expect(statusChanges[0]?.previousStatus).toBe('todo')
    expect(statusChanges[0]?.workItem.status).toBe('in_progress')
  })

  it('notifies snapshot subscribers after committed changes', () => {
    const { store } = createTestStore()
    const snapshots: ProjectManagementState[] = []
    const unsubscribe = store.subscribeSnapshot((snapshot) => {
      snapshots.push({
        ...snapshot,
        version: 1,
      })
    })

    const project = store.registerProject({
      rootPath: 'F:/workspace/my-app',
      issuePrefix: 'AIRI',
      gitEnabled: true,
    })
    const created = store.createWorkItem({
      projectId: project.id,
      identifier: 'AIRI-12',
      title: 'Add board',
      goal: 'Show local work items',
      acceptanceCriteria: ['Board lists todo cards'],
    })
    store.updateWorkItem({
      id: created.workItem!.id,
      patch: { status: 'in_review' },
    })
    unsubscribe()
    store.updateWorkItem({
      id: created.workItem!.id,
      patch: { status: 'done' },
    })

    expect(snapshots).toHaveLength(3)
    expect(snapshots[0]?.projects[0]?.issuePrefix).toBe('AIRI')
    expect(snapshots[1]?.workItems[0]?.status).toBe('todo')
    expect(snapshots[2]?.workItems[0]?.status).toBe('in_review')
  })

  it('stores and clears work item commit prefixes', () => {
    const { store } = createTestStore()
    const project = store.registerProject({
      rootPath: 'F:/workspace/my-app',
      issuePrefix: 'AIRI',
      gitEnabled: true,
    })
    const created = store.createWorkItem({
      projectId: project.id,
      identifier: 'AIRI-12',
      title: 'Add board',
      goal: 'Show local work items',
      acceptanceCriteria: ['Board lists todo cards'],
      commitPrefix: 'AC-781',
    })

    expect(created.workItem?.commitPrefix).toBe('AC-781')

    const updated = store.updateWorkItem({
      id: created.workItem!.id,
      patch: { commitPrefix: null },
    })

    expect(updated.commitPrefix).toBeUndefined()
  })

  it('replaces and de-duplicates settings lists instead of appending defaults on every save', () => {
    const { store } = createTestStore()

    const first = store.updateSettings({
      shellDenylist: ['rm', 'del', 'git reset', 'git clean'],
    })
    const second = store.updateSettings({
      shellDenylist: ['rm', 'del', 'git reset', 'git clean'],
    })
    const cleaned = store.updateSettings({
      shellDenylist: ['rm', 'del', 'git reset', 'git clean', 'rm', ' del '],
      verifierCommands: ['pnpm typecheck', 'pnpm test', 'pnpm typecheck', ' pnpm test '],
    })

    expect(first.shellDenylist).toEqual(['rm', 'del', 'git reset', 'git clean'])
    expect(second.shellDenylist).toEqual(['rm', 'del', 'git reset', 'git clean'])
    expect(cleaned.shellDenylist).toEqual(['rm', 'del', 'git reset', 'git clean'])
    expect(cleaned.verifierCommands).toEqual(['pnpm typecheck', 'pnpm test'])
  })

  // ROOT CAUSE:
  //
  // Older persisted settings snapshots can miss fields that were added later.
  // The list merge path used an undefined fallback directly, so the first save
  // after an upgrade could throw before validation had a chance to write defaults.
  //
  // We fixed this by treating missing fallback lists as empty lists.
  it('keeps legacy settings snapshots without verifier commands loadable', () => {
    const defaults = createDefaultProjectManagementState().settings
    const legacy = { ...defaults } as Partial<ProjectAgentSettings>
    delete legacy.verifierCommands

    const merged = mergeProjectAgentSettings(legacy as ProjectAgentSettings, {})

    expect(merged.verifierCommands).toEqual([])
    expect(merged.shellDenylist).toEqual(defaults.shellDenylist)
  })

  it('keeps an intentionally cleared denylist empty after saving settings', () => {
    const { store } = createTestStore()

    const cleared = store.updateSettings({
      shellDenylist: [],
    })
    const savedAgain = store.updateSettings({
      shellDenylist: [],
    })

    expect(cleared.shellDenylist).toEqual([])
    expect(savedAgain.shellDenylist).toEqual([])
    expect(store.getSnapshot().settings.shellDenylist).toEqual([])
  })

  it('deletes a work item with its comments and run records', () => {
    const { store } = createTestStore()
    const project = store.registerProject({
      rootPath: 'F:/workspace/my-app',
      issuePrefix: 'AIRI',
      gitEnabled: true,
    })
    const created = store.createWorkItem({
      projectId: project.id,
      identifier: 'AIRI-12',
      title: 'Add board',
      goal: 'Show local work items',
      acceptanceCriteria: ['Board lists todo cards'],
    })
    store.addComment({
      workItemId: created.workItem!.id,
      actorType: 'airi',
      kind: 'comment',
      content: 'note',
    })
    store.upsertRunRecord({
      id: 'run-1',
      workItemId: created.workItem!.id,
      status: 'done',
      startedAt: 1,
      finishedAt: 2,
      attempt: 1,
      changedFiles: [],
    })

    store.deleteWorkItem(created.workItem!.id)

    const snapshot = store.getSnapshot()
    expect(snapshot.workItems).toHaveLength(0)
    expect(snapshot.comments).toHaveLength(0)
    expect(snapshot.runs).toHaveLength(0)
  })
})
