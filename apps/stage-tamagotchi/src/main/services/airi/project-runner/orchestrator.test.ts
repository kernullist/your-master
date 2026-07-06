import type { Project, WorkItem, WorkItemRunRecord } from '@proj-airi/stage-projects'

import type { AgentRuntimeFetch } from './agent-runtime'
import type { ReviewerAgentResult } from './review-loop'

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultProjectAgentSettings } from '@proj-airi/stage-projects'
import { describe, expect, it, vi } from 'vitest'

import { removeAgentWorktree, runGit } from './git'
import { combineAdversarialReview, createPreReviewGateDecision, parseAgentJsonObject, runExploreSubAgent, runProjectWorkItem } from './orchestrator'

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

function createWorkerFinalResponse(comment: string, acceptanceCriteria: string[]) {
  return createAgentResponse(JSON.stringify({
    action: 'final',
    comment,
    acceptanceEvidence: acceptanceCriteria.map(criterion => ({
      criterion,
      status: 'satisfied',
      evidence: 'Verified by worker changes and validation.',
    })),
  }))
}

function createReviewerPassResponse(acceptanceCriteria: string[]) {
  return createAgentResponse(JSON.stringify(createReviewerPassPayload(acceptanceCriteria)))
}

function createReviewerPassPayload(acceptanceCriteria: string[]) {
  return {
    passed: true,
    comment: 'Looks good',
    findings: [],
    requiredChanges: [],
    suggestedTests: [],
    acceptanceEvidence: acceptanceCriteria.map(criterion => ({
      criterion,
      status: 'satisfied',
      evidence: 'Verified by reviewer inspection.',
    })),
    confidence: 0.9,
  }
}

describe('project work item orchestrator', () => {
  it('creates deterministic pre-review failures before reviewer model review', () => {
    const workItem: WorkItem = {
      id: 'work-1',
      projectId: 'project-1',
      identifier: 'AIRI-10',
      title: 'Need evidence',
      goal: 'Change code with evidence',
      acceptanceCriteria: ['source changed'],
      status: 'todo',
      position: 0,
      createdAt: 1,
      updatedAt: 1,
    }

    const decision = createPreReviewGateDecision({
      forbiddenPathPatterns: ['secret'],
      workItem,
      workerResult: {
        changedFiles: ['secret/file.ts'],
        comment: 'done',
        diffSummary: '',
        testSummary: 'Command: pnpm test\nExit code: 1\nTimed out: false',
        acceptanceEvidence: [],
      },
    })

    expect(decision?.passed).toBe(false)
    expect(decision?.findings?.map(finding => finding.message)).toContain('Worker changed forbidden paths: secret/file.ts')
    expect(decision?.findings?.some(finding => finding.message.includes('Validation failed'))).toBe(true)
    expect(decision?.findings?.some(finding => finding.message.includes('Missing acceptance evidence'))).toBe(true)
  })

  it('blocks on structured validation exit codes even when the summary text looks clean', () => {
    const workItem: WorkItem = {
      id: 'work-2',
      projectId: 'project-1',
      identifier: 'AIRI-12',
      title: 'Grounded validation',
      goal: 'Change code and validate',
      acceptanceCriteria: ['source changed'],
      status: 'todo',
      position: 0,
      createdAt: 1,
      updatedAt: 1,
    }

    const decision = createPreReviewGateDecision({
      forbiddenPathPatterns: [],
      workItem,
      workerResult: {
        changedFiles: ['src/app.ts'],
        comment: 'done',
        diffSummary: 'src/app.ts changed',
        // No failing text summary, but the structured exit code is the trusted signal.
        testSummary: '',
        validationResults: [{ command: 'pnpm test', exitCode: 1, timedOut: false }],
        acceptanceEvidence: [{ criterion: 'source changed', status: 'satisfied', evidence: 'src/app.ts edited.' }],
      },
    })

    expect(decision?.passed).toBe(false)
    expect(decision?.failureKind).toBe('validation_failed')
    expect(decision?.findings?.some(finding => finding.message.includes('Validation failed'))).toBe(true)
  })

  it('trusts passing structured validation over a scary-looking summary text', () => {
    const workItem: WorkItem = {
      id: 'work-3',
      projectId: 'project-1',
      identifier: 'AIRI-13',
      title: 'Grounded pass',
      goal: 'Change code and validate',
      acceptanceCriteria: ['source changed'],
      status: 'todo',
      position: 0,
      createdAt: 1,
      updatedAt: 1,
    }

    const decision = createPreReviewGateDecision({
      forbiddenPathPatterns: [],
      workItem,
      workerResult: {
        changedFiles: ['src/app.ts'],
        comment: 'done',
        diffSummary: 'src/app.ts changed',
        // The regex would flag this text, but the structured all-pass result wins.
        testSummary: 'Command: pnpm test\nExit code: 1\nTimed out: false',
        validationResults: [{ command: 'pnpm test', exitCode: 0, timedOut: false }],
        acceptanceEvidence: [{ criterion: 'source changed', status: 'satisfied', evidence: 'src/app.ts edited.' }],
      },
    })

    expect(decision).toBeUndefined()
  })

  it('parses a bare JSON object action', () => {
    expect(parseAgentJsonObject('{"action":"read","path":"a.ts"}')).toEqual({ action: 'read', path: 'a.ts' })
  })

  it('parses a fenced JSON action wrapped in prose', () => {
    const text = 'Here is my next action:\n```json\n{"action":"final","comment":"done"}\n```\nLet me know if that works.'
    expect(parseAgentJsonObject(text)).toEqual({ action: 'final', comment: 'done' })
  })

  it('parses an uppercase fence and ignores trailing text', () => {
    expect(parseAgentJsonObject('```JSON\n{"action":"status"}\n```\nthanks')).toEqual({ action: 'status' })
  })

  it('ignores braces that appear inside string values', () => {
    const text = 'prefix {"action":"write","content":"if (x) { return {} }"} suffix'
    expect(parseAgentJsonObject(text)).toEqual({ action: 'write', content: 'if (x) { return {} }' })
  })

  it('throws a clear error when no JSON object is present', () => {
    expect(() => parseAgentJsonObject('no json here')).toThrow('must contain a JSON object')
  })

  it('runs a read-only explore sub-agent and returns its distilled summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airi-project-orchestrator-explore-'))
    try {
      await writeFile(join(root, 'target.ts'), 'export function foo() {\n  return 1\n}\n')
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
      const responses = [
        createAgentResponse(JSON.stringify({ action: 'search', query: 'foo' })),
        createAgentResponse(JSON.stringify({ action: 'read', path: 'target.ts' })),
        createAgentResponse(JSON.stringify({ action: 'final', summary: 'foo is defined in target.ts:1' })),
      ]
      const fetcher = vi.fn<AgentRuntimeFetch>(async () => responses.shift() ?? createAgentResponse('{"action":"final","summary":"done"}'))

      const summary = await runExploreSubAgent({
        objective: 'Where is foo defined?',
        fetcher,
        project,
        projectRoot: root,
        settings: defaultProjectAgentSettings,
      })

      expect(summary).toBe('foo is defined in target.ts:1')
      // The sub-agent ran its own read-only loop (search, read, final) before answering.
      expect(fetcher).toHaveBeenCalledTimes(3)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a passing review when the adversarial refuter also passes', () => {
    const primary: ReviewerAgentResult = { passed: true, comment: 'Looks correct', confidence: 0.9 }
    const refuter: ReviewerAgentResult = { passed: true, comment: 'Could not refute' }

    expect(combineAdversarialReview(primary, refuter)).toBe(primary)
  })

  it('fails closed and merges findings when the adversarial refuter rejects', () => {
    const primary: ReviewerAgentResult = {
      passed: true,
      comment: 'Looks correct',
      requiredChanges: ['keep tests green'],
      findings: [{ severity: 'nit', message: 'style' }],
    }
    const refuter: ReviewerAgentResult = {
      passed: false,
      comment: 'Criterion 2 is not actually met',
      requiredChanges: ['handle the empty-input case', 'keep tests green'],
      findings: [{ severity: 'blocker', message: 'empty input crashes' }],
      failureKind: 'review_rejected',
      confidence: 0.8,
    }

    const combined = combineAdversarialReview(primary, refuter)

    expect(combined.passed).toBe(false)
    expect(combined.failureKind).toBe('review_rejected')
    expect(combined.comment).toContain('Criterion 2 is not actually met')
    expect(combined.findings).toHaveLength(2)
    // Required changes are merged and de-duplicated, first occurrence order preserved.
    expect(combined.requiredChanges).toEqual(['keep tests green', 'handle the empty-input case'])
  })

  it('lets the worker use richer file and validation tools without git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airi-project-orchestrator-tools-'))
    try {
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
        identifier: 'AIRI-11',
        title: 'Create generated file',
        goal: 'Create a generated text file',
        acceptanceCriteria: ['generated.txt exists'],
        status: 'todo',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      const responses = [
        createAgentResponse(JSON.stringify({ action: 'find', query: 'generated' })),
        createAgentResponse(JSON.stringify({ action: 'write', path: 'generated.txt', content: 'after\n' })),
        createAgentResponse(JSON.stringify({ action: 'test', commands: ['node -e "console.log(123)"'] })),
        createAgentResponse(JSON.stringify({ action: 'status' })),
        createAgentResponse(JSON.stringify({ action: 'diff' })),
        createWorkerFinalResponse('Created generated.txt', workItem.acceptanceCriteria),
        createReviewerPassResponse(workItem.acceptanceCriteria),
      ]
      const fetcher = vi.fn<AgentRuntimeFetch>(async () => responses.shift() ?? createWorkerFinalResponse('done', workItem.acceptanceCriteria))
      const runs: WorkItemRunRecord[] = []

      await runProjectWorkItem({
        fetcher,
        generateId: () => 'run-tools',
        now: () => 1000,
        project,
        settings: defaultProjectAgentSettings,
        store: {
          addComment: () => {},
          updateWorkItem: payload => ({ ...workItem, status: payload.patch.status }),
          upsertRunRecord: (run) => {
            runs.push(run)
            return run
          },
        },
        workItem,
      })

      const generated = await readFile(join(root, 'generated.txt'), 'utf-8')

      expect(generated).toBe('after\n')
      expect(runs.at(-1)?.changedFiles).toEqual(['generated.txt'])
      expect(runs.at(-1)?.status).toBe('done')
      expect(runs.at(-1)?.lifecycleStatus).toBe('completed')
      expect(runs.at(-1)?.worktreeState).toBe('none')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)

  it('records normalized changed file paths for non-git replace actions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airi-project-orchestrator-normalized-replace-'))
    try {
      await writeFile(join(root, 'note.txt'), 'before\n')
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
        identifier: 'AIRI-20',
        title: 'Normalize replace path',
        goal: 'Update a note file',
        acceptanceCriteria: ['note.txt says after'],
        status: 'todo',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      const runs: WorkItemRunRecord[] = []
      const responses = [
        createAgentResponse(JSON.stringify({ action: 'replace', path: './note.txt', search: 'before', replace: 'after' })),
        createWorkerFinalResponse('Updated note.txt', workItem.acceptanceCriteria),
        createReviewerPassResponse(workItem.acceptanceCriteria),
      ]
      const fetcher = vi.fn<AgentRuntimeFetch>(async () => responses.shift() ?? createWorkerFinalResponse('done', workItem.acceptanceCriteria))

      await runProjectWorkItem({
        fetcher,
        generateId: () => 'run-normalized-replace',
        now: () => 1000,
        project,
        settings: defaultProjectAgentSettings,
        store: {
          addComment: () => {},
          updateWorkItem: payload => ({ ...workItem, status: payload.patch.status }),
          upsertRunRecord: (run) => {
            runs.push(run)
            return run
          },
        },
        workItem,
      })

      expect(runs.at(-1)?.changedFiles).toEqual(['note.txt'])
      expect(runs.at(-1)?.status).toBe('done')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)

  it('returns worker tool errors to the agent so it can recover', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airi-project-orchestrator-tool-error-'))
    try {
      await writeFile(join(root, 'note.txt'), 'before\n')
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
        identifier: 'AIRI-23',
        title: 'Recover from tool error',
        goal: 'Update a note after a failed patch attempt',
        acceptanceCriteria: ['note.txt says after'],
        status: 'todo',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      const runs: WorkItemRunRecord[] = []
      const responses = [
        createAgentResponse(JSON.stringify({ action: 'replace', path: 'note.txt', search: 'missing', replace: 'after' })),
        createAgentResponse(JSON.stringify({ action: 'read', path: 'note.txt' })),
        createAgentResponse(JSON.stringify({ action: 'replace', path: 'note.txt', search: 'before', replace: 'after' })),
        createWorkerFinalResponse('Recovered and updated note.txt', workItem.acceptanceCriteria),
        createReviewerPassResponse(workItem.acceptanceCriteria),
      ]
      const fetcher = vi.fn<AgentRuntimeFetch>(async () => responses.shift() ?? createWorkerFinalResponse('done', workItem.acceptanceCriteria))

      // ROOT CAUSE:
      //
      // A deterministic tool guard can fail for recoverable reasons, such as a
      // stale exact patch string. Throwing that error out of the worker loop
      // blocked the whole run before the model could inspect and retry.
      //
      // We fixed this by returning tool errors as the next tool result turn.
      await runProjectWorkItem({
        fetcher,
        generateId: () => 'run-tool-error',
        now: () => 1000,
        project,
        settings: defaultProjectAgentSettings,
        store: {
          addComment: () => {},
          updateWorkItem: payload => ({ ...workItem, status: payload.patch.status }),
          upsertRunRecord: (run) => {
            runs.push(run)
            return run
          },
        },
        workItem,
      })

      const updated = await readFile(join(root, 'note.txt'), 'utf-8')
      const requestBodies = fetcher.mock.calls.map(call => JSON.parse(call[1].body) as { messages?: Array<{ content?: string }> })

      expect(updated).toBe('after\n')
      expect(runs.at(-1)?.status).toBe('done')
      expect(requestBodies.some(body => body.messages?.some(message => message.content?.includes('Patch search text was not found in note.txt')))).toBe(true)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)

  it('lets the reviewer inspect files with tools before the final decision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airi-project-orchestrator-reviewer-tools-'))
    try {
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
        identifier: 'AIRI-17',
        title: 'Reviewer reads output',
        goal: 'Create reviewed output',
        acceptanceCriteria: ['reviewed.txt contains ok'],
        status: 'todo',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      const responses = [
        createAgentResponse(JSON.stringify({ action: 'write', path: 'reviewed.txt', content: 'ok\n' })),
        createWorkerFinalResponse('Created reviewed.txt', workItem.acceptanceCriteria),
        createAgentResponse(JSON.stringify({ action: 'read', path: 'reviewed.txt' })),
        createReviewerPassResponse(workItem.acceptanceCriteria),
      ]
      const fetcher = vi.fn<AgentRuntimeFetch>(async () => responses.shift() ?? createReviewerPassResponse(workItem.acceptanceCriteria))

      await runProjectWorkItem({
        fetcher,
        generateId: () => 'run-reviewer-tools',
        now: () => 1000,
        project,
        settings: defaultProjectAgentSettings,
        store: {
          addComment: () => {},
          updateWorkItem: payload => ({ ...workItem, status: payload.patch.status }),
          upsertRunRecord: run => run,
        },
        workItem,
      })

      const requestBodies = fetcher.mock.calls.map(call => JSON.parse(call[1].body) as { messages?: Array<{ content?: string }> })

      expect(requestBodies.some(body => body.messages?.some(message => message.content?.includes('Reviewer tool result:\nok')))).toBe(true)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)

  it('reports worker subtask progress and user questions when blocked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airi-project-orchestrator-blocked-question-'))
    try {
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
        identifier: 'AIRI-19',
        title: 'Needs product decision',
        goal: 'Choose a provider before implementation',
        acceptanceCriteria: ['Provider is selected'],
        status: 'todo',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      const comments: Array<{ actorType: string, content: string, kind: string, workItemId: string }> = []
      const runs: WorkItemRunRecord[] = []
      const responses = [
        createAgentResponse(JSON.stringify({
          summary: 'Clarify provider.',
          likelyFiles: [],
          implementationPlan: ['Ask for provider'],
          subtasks: ['Pick provider'],
          riskNotes: ['Wrong provider would waste implementation work'],
          reviewFocus: ['Provider decision'],
          suggestedTests: [],
          openQuestions: ['Which provider should own this integration?'],
        })),
        createAgentResponse(JSON.stringify({
          action: 'subtask',
          title: 'Pick provider',
          status: 'blocked',
          evidence: 'Provider is ambiguous.',
        })),
        createAgentResponse(JSON.stringify({
          action: 'blocked',
          comment: 'Provider choice is required before implementation.',
          failureKind: 'worker_blocked',
          questions: ['Which provider should own this integration?'],
          subtaskProgress: [{
            title: 'Pick provider',
            status: 'blocked',
            evidence: 'Provider is ambiguous.',
          }],
        })),
      ]
      const fetcher = vi.fn<AgentRuntimeFetch>(async () => responses.shift() ?? createWorkerFinalResponse('done', workItem.acceptanceCriteria))

      await runProjectWorkItem({
        fetcher,
        generateId: () => 'run-blocked-question',
        now: () => 1000,
        project,
        settings: {
          ...defaultProjectAgentSettings,
          projectManager: {
            ...defaultProjectAgentSettings.projectManager,
            model: 'manager-model',
          },
        },
        store: {
          addComment: payload => comments.push(payload),
          updateWorkItem: payload => ({ ...workItem, status: payload.patch.status }),
          upsertRunRecord: (run) => {
            runs.push(run)
            return run
          },
        },
        workItem,
      })

      expect(runs.at(-1)?.status).toBe('blocked')
      expect(runs.at(-1)?.lifecycleStatus).toBe('blocked')
      expect(runs.at(-1)?.error).toContain('[worker_blocked]')
      expect(runs.at(-1)?.planSummary).toBe('Clarify provider.')
      expect(runs.at(-1)?.subtaskProgress).toEqual([{
        title: 'Pick provider',
        status: 'blocked',
        evidence: 'Provider is ambiguous.',
      }])
      expect(comments.some(comment => comment.content.includes('서브태스크 진행상황'))).toBe(true)
      expect(comments.some(comment => comment.content.includes('Which provider should own this integration?'))).toBe(true)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)

  it('accepts nested reviewer final decision payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airi-project-orchestrator-nested-review-'))
    try {
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
        identifier: 'AIRI-18',
        title: 'Nested reviewer final',
        goal: 'Accept reviewer final tool schema',
        acceptanceCriteria: ['nested.txt exists'],
        status: 'todo',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      const runs: WorkItemRunRecord[] = []
      const responses = [
        createAgentResponse(JSON.stringify({ action: 'write', path: 'nested.txt', content: 'ok\n' })),
        createWorkerFinalResponse('Created nested.txt', workItem.acceptanceCriteria),
        createAgentResponse(JSON.stringify({
          action: 'final',
          decision: createReviewerPassPayload(workItem.acceptanceCriteria),
        })),
      ]
      const fetcher = vi.fn<AgentRuntimeFetch>(async () => responses.shift() ?? createWorkerFinalResponse('done', workItem.acceptanceCriteria))

      await runProjectWorkItem({
        fetcher,
        generateId: () => 'run-nested-review',
        now: () => 1000,
        project,
        settings: defaultProjectAgentSettings,
        store: {
          addComment: () => {},
          updateWorkItem: payload => ({ ...workItem, status: payload.patch.status }),
          upsertRunRecord: (run) => {
            runs.push(run)
            return run
          },
        },
        workItem,
      })

      expect(runs.at(-1)?.status).toBe('done')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)

  it('keeps explicit reviewer failure kinds in the final run error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airi-project-orchestrator-review-failure-kind-'))
    try {
      await writeFile(join(root, 'validation.txt'), 'before\n')
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
        identifier: 'AIRI-22',
        title: 'Keep reviewer failure kind',
        goal: 'Make a change that reviewer rejects',
        acceptanceCriteria: ['validation.txt says after'],
        status: 'todo',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      const runs: WorkItemRunRecord[] = []
      const responses = [
        createAgentResponse(JSON.stringify({ action: 'replace', path: 'validation.txt', search: 'before', replace: 'after' })),
        createWorkerFinalResponse('Updated validation.txt', workItem.acceptanceCriteria),
        createAgentResponse(JSON.stringify({
          passed: false,
          comment: 'Needs another check',
          failureKind: 'validation_failed',
          findings: [],
          requiredChanges: ['Run the validation command again'],
          suggestedTests: [],
          acceptanceEvidence: workItem.acceptanceCriteria.map(criterion => ({
            criterion,
            status: 'satisfied',
            evidence: 'Changed validation.txt.',
          })),
          confidence: 0.7,
        })),
      ]
      const fetcher = vi.fn<AgentRuntimeFetch>(async () => responses.shift() ?? createReviewerPassResponse(workItem.acceptanceCriteria))

      await runProjectWorkItem({
        fetcher,
        generateId: () => 'run-review-failure-kind',
        now: () => 1000,
        project,
        settings: {
          ...defaultProjectAgentSettings,
          maxReviewRetries: 1,
        },
        store: {
          addComment: () => {},
          updateWorkItem: payload => ({ ...workItem, status: payload.patch.status }),
          upsertRunRecord: (run) => {
            runs.push(run)
            return run
          },
        },
        workItem,
      })

      expect(runs.at(-1)?.status).toBe('blocked')
      expect(runs.at(-1)?.error).toContain('[validation_failed]')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)

  it('allows worker write and replace actions to use empty content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'airi-project-orchestrator-empty-'))
    try {
      await writeFile(join(root, 'remove.txt'), 'delete me\n')
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
        identifier: 'AIRI-16',
        title: 'Allow empty file writes',
        goal: 'Allow the worker to delete text and create empty files',
        acceptanceCriteria: ['remove.txt is empty', 'empty.txt exists and is empty'],
        status: 'todo',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      // ROOT CAUSE:
      //
      // The worker JSON parser reused the non-empty string validator for
      // replace.replace and write.content. That blocked legitimate edits like
      // deleting a matched text range or creating an intentionally empty file.
      //
      // We fixed this by requiring those fields to be strings while allowing
      // the empty string value through to the deterministic file tools.
      const responses = [
        createAgentResponse(JSON.stringify({ action: 'replace', path: 'remove.txt', search: 'delete me\n', replace: '' })),
        createAgentResponse(JSON.stringify({ action: 'write', path: 'empty.txt', content: '' })),
        createWorkerFinalResponse('Created empty outputs', workItem.acceptanceCriteria),
        createReviewerPassResponse(workItem.acceptanceCriteria),
      ]
      const fetcher = vi.fn<AgentRuntimeFetch>(async () => responses.shift() ?? createWorkerFinalResponse('done', workItem.acceptanceCriteria))

      await runProjectWorkItem({
        fetcher,
        generateId: () => 'run-empty',
        now: () => 1000,
        project,
        settings: defaultProjectAgentSettings,
        store: {
          addComment: () => {},
          updateWorkItem: payload => ({ ...workItem, status: payload.patch.status }),
          upsertRunRecord: run => run,
        },
        workItem,
      })

      const removed = await readFile(join(root, 'remove.txt'), 'utf-8')
      const empty = await readFile(join(root, 'empty.txt'), 'utf-8')

      expect(removed).toBe('')
      expect(empty).toBe('')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)

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
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      const comments: Array<{ actorType: string, content: string, kind: string, workItemId: string }> = []
      const runs: WorkItemRunRecord[] = []
      const statuses: WorkItem['status'][] = []
      const responses = [
        createAgentResponse(JSON.stringify({
          summary: 'Update the tracked text file.',
          implementationPlan: ['Read agent.txt', 'Replace before with after'],
          riskNotes: ['Only touch agent.txt'],
          reviewFocus: ['agent.txt contains after'],
          suggestedTests: ['Inspect git diff'],
        })),
        createAgentResponse(JSON.stringify({ action: 'read', path: 'agent.txt' })),
        createAgentResponse(JSON.stringify({ action: 'replace', path: 'agent.txt', search: 'before', replace: 'after' })),
        createWorkerFinalResponse('Updated agent.txt', workItem.acceptanceCriteria),
        createReviewerPassResponse(workItem.acceptanceCriteria),
      ]
      const fetcher = vi.fn<AgentRuntimeFetch>(async () => responses.shift() ?? createWorkerFinalResponse('done', workItem.acceptanceCriteria))

      await runProjectWorkItem({
        fetcher,
        generateId: () => 'run-1',
        now: () => 1000,
        project,
        settings: {
          ...defaultProjectAgentSettings,
          projectManager: {
            ...defaultProjectAgentSettings.projectManager,
            model: 'manager-model',
          },
          autoCommit: true,
          verifierCommands: ['node -e "process.exit(0)"'],
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
      const branchFile = await runGit(root, ['show', 'airi/work/airi-12/run-1:agent.txt'])
      const status = await runGit(root, ['status', '--porcelain'])
      const requestBodies = fetcher.mock.calls.map(call => JSON.parse(call[1].body) as { messages?: Array<{ content?: string }>, model?: string })

      expect(originalFile.replace(/\r\n/g, '\n')).toBe('after\n')
      expect(branchFile.stdout.replace(/\r\n/g, '\n')).toBe('after\n')
      expect(status.stdout.trim()).toBe('')
      expect(requestBodies[0]?.model).toBe('manager-model')
      expect(requestBodies[1]?.messages?.some(message => message.content?.includes('Project manager brief'))).toBe(true)
      expect(requestBodies.at(-1)?.messages?.some(message => message.content?.includes('Project manager brief'))).toBe(true)
      expect(statuses).toEqual(['in_progress', 'in_review', 'done'])
      expect(comments.some(comment => comment.content.includes('worktree'))).toBe(true)
      expect(comments.some(comment => comment.content.includes('Project Manager brief'))).toBe(true)
      expect(comments.some(comment => comment.kind === 'commit' && comment.content.includes('자동 커밋 완료'))).toBe(true)
      expect(comments.some(comment => comment.kind === 'commit' && comment.content.includes('원본 프로젝트'))).toBe(true)
      expect(runs.at(-1)?.status).toBe('done')
      expect(runs.at(-1)?.lifecycleStatus).toBe('completed')
      expect(runs.at(-1)?.worktreeState).toBe('removed')
      expect(runs.at(-1)?.planSummary).toBe('Update the tracked text file.')
      expect(runs.at(-1)?.planSteps).toEqual(['Read agent.txt', 'Replace before with after'])
      expect(runs.at(-1)?.riskNotes).toEqual(['Only touch agent.txt'])
      expect(runs.at(-1)?.reviewFocus).toEqual(['agent.txt contains after'])
      expect(runs.at(-1)?.verificationCommands).toEqual(['node -e "process.exit(0)"'])
      expect(runs.at(-1)?.branchName).toBe('airi/work/airi-12/run-1')
    })
  }, 30000)

  it('uses git-detected shell edits when selecting worker-requested validation', async () => {
    await withGitProject(async (root) => {
      await writeFile(join(root, 'package.json'), JSON.stringify({
        scripts: {
          test: 'node -e "console.log(\'generic\')"',
          typecheck: 'node -e "console.log(\'typed\')"',
        },
      }))
      await runGit(root, ['add', 'package.json'])
      await runGit(root, ['commit', '-m', 'test: add validation scripts'])

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
        identifier: 'AIRI-21',
        title: 'Shell creates typed file',
        goal: 'Create a typed file using shell',
        acceptanceCriteria: ['typed.ts exists'],
        status: 'todo',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      const comments: Array<{ actorType: string, content: string, kind: string, workItemId: string }> = []
      const runs: WorkItemRunRecord[] = []
      const responses = [
        createAgentResponse(JSON.stringify({
          action: 'shell',
          command: 'node -e "require(\'fs\').writeFileSync(\'typed.ts\', \'export const value = 1\\\\n\')"',
        })),
        createAgentResponse(JSON.stringify({ action: 'test' })),
        createWorkerFinalResponse('Created typed.ts', workItem.acceptanceCriteria),
        createReviewerPassResponse(workItem.acceptanceCriteria),
      ]
      const fetcher = vi.fn<AgentRuntimeFetch>(async () => responses.shift() ?? createReviewerPassResponse(workItem.acceptanceCriteria))

      await runProjectWorkItem({
        fetcher,
        generateId: () => 'run-shell-validation',
        now: () => 1000,
        project,
        settings: {
          ...defaultProjectAgentSettings,
          autoCommit: false,
        },
        store: {
          addComment: payload => comments.push(payload),
          updateWorkItem: payload => ({ ...workItem, status: payload.patch.status }),
          upsertRunRecord: (run) => {
            runs.push(run)
            return run
          },
        },
        workItem,
      })

      const testComment = comments.find(comment => comment.kind === 'test')?.content ?? ''
      const worktreePath = runs.at(-1)?.worktreePath

      expect(testComment).toContain('Worker-requested validation:\nCommand: npm run typecheck')
      expect(runs.at(-1)?.changedFiles).toEqual(['typed.ts'])

      if (worktreePath)
        await removeAgentWorktree(root, worktreePath)
    })
  }, 30000)

  it('preserves reviewed worktree changes when auto commit is disabled', async () => {
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
        identifier: 'AIRI-13',
        title: 'Keep reviewed changes',
        goal: 'Change the agent text file',
        acceptanceCriteria: ['agent.txt says after'],
        status: 'todo',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      const comments: Array<{ actorType: string, content: string, kind: string, workItemId: string }> = []
      const runs: WorkItemRunRecord[] = []
      const responses = [
        createAgentResponse(JSON.stringify({ action: 'read', path: 'agent.txt' })),
        createAgentResponse(JSON.stringify({ action: 'replace', path: 'agent.txt', search: 'before', replace: 'after' })),
        createWorkerFinalResponse('Updated agent.txt', workItem.acceptanceCriteria),
        createReviewerPassResponse(workItem.acceptanceCriteria),
      ]
      const fetcher = vi.fn<AgentRuntimeFetch>(async () => responses.shift() ?? createWorkerFinalResponse('done', workItem.acceptanceCriteria))

      await runProjectWorkItem({
        fetcher,
        generateId: () => 'run-keep',
        now: () => 1000,
        project,
        settings: {
          ...defaultProjectAgentSettings,
          autoCommit: false,
        },
        store: {
          addComment: payload => comments.push(payload),
          updateWorkItem: payload => ({ ...workItem, status: payload.patch.status }),
          upsertRunRecord: (run) => {
            runs.push(run)
            return run
          },
        },
        workItem,
      })

      const originalFile = await readFile(join(root, 'agent.txt'), 'utf-8')
      const worktreePath = runs.at(-1)?.worktreePath
      const worktreeFile = await readFile(join(worktreePath ?? '', 'agent.txt'), 'utf-8')

      expect(originalFile.replace(/\r\n/g, '\n')).toBe('before\n')
      expect(worktreePath).toBeDefined()
      expect(existsSync(worktreePath ?? '')).toBe(true)
      expect(worktreeFile.replace(/\r\n/g, '\n')).toBe('after\n')
      expect(runs.at(-1)?.status).toBe('done')
      expect(runs.at(-1)?.worktreeState).toBe('preserved')
      expect(comments.some(comment => comment.kind === 'commit' && comment.content.includes('worktree에 보존'))).toBe(true)

      if (worktreePath)
        await removeAgentWorktree(root, worktreePath)
    })
  }, 30000)

  it('blocks the work item and preserves worktree when integration conflicts', async () => {
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
        identifier: 'AIRI-14',
        title: 'Handle integration conflict',
        goal: 'Change the agent text file',
        acceptanceCriteria: ['agent.txt says agent change'],
        status: 'todo',
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      const comments: Array<{ actorType: string, content: string, kind: string, workItemId: string }> = []
      const runs: WorkItemRunRecord[] = []
      const statuses: WorkItem['status'][] = []
      const responses = [
        createAgentResponse(JSON.stringify({ action: 'read', path: 'agent.txt' })),
        createAgentResponse(JSON.stringify({ action: 'replace', path: 'agent.txt', search: 'before', replace: 'agent change' })),
        createWorkerFinalResponse('Updated agent.txt', workItem.acceptanceCriteria),
      ]
      const fetcher = vi.fn<AgentRuntimeFetch>(async () => {
        if (responses.length > 0)
          return responses.shift()!

        await writeFile(join(root, 'agent.txt'), 'human concurrent change\n')
        await runGit(root, ['add', 'agent.txt'])
        await runGit(root, ['commit', '-m', 'chore: human concurrent change'])
        return createReviewerPassResponse(workItem.acceptanceCriteria)
      })

      await runProjectWorkItem({
        fetcher,
        generateId: () => 'run-conflict',
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
      const worktreePath = runs.at(-1)?.worktreePath
      const worktreeFile = await readFile(join(worktreePath ?? '', 'agent.txt'), 'utf-8')
      const branchFile = await runGit(root, ['show', 'airi/work/airi-14/run-conflict:agent.txt'])
      const status = await runGit(root, ['status', '--porcelain'])

      expect(originalFile.replace(/\r\n/g, '\n')).toBe('human concurrent change\n')
      expect(worktreePath).toBeDefined()
      expect(existsSync(worktreePath ?? '')).toBe(true)
      expect(worktreeFile.replace(/\r\n/g, '\n')).toBe('agent change\n')
      expect(branchFile.stdout.replace(/\r\n/g, '\n')).toBe('agent change\n')
      expect(status.stdout.trim()).toBe('')
      expect(statuses.at(-1)).toBe('blocked')
      expect(runs.at(-1)?.status).toBe('blocked')
      expect(runs.at(-1)?.error).toContain('could not apply')
      expect(comments.some(comment => comment.kind === 'status' && comment.content.includes('수동 통합이 필요'))).toBe(true)

      if (worktreePath)
        await removeAgentWorktree(root, worktreePath)
    })
  }, 30000)
})
