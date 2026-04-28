import { describe, expect, it } from 'vitest'

import * as v from 'valibot'

import { formatDirtyWorktreeStartMessage, getConcurrentRunLimitMessage, projectManagementStateSchema } from './index'

describe('project management service', () => {
  it('allows runs below the configured concurrent limit', () => {
    expect(getConcurrentRunLimitMessage(0, 2)).toBeUndefined()
    expect(getConcurrentRunLimitMessage(1, 2)).toBeUndefined()
  })

  it('blocks new runs at the configured concurrent limit', () => {
    expect(getConcurrentRunLimitMessage(2, 2)).toBe('이미 2개의 일감이 실행 중이야. 현재 동시 실행 최대치는 2개야.')
  })

  it('keeps older project-management files valid when maxConcurrentRuns is missing', () => {
    const parsed = v.parse(projectManagementStateSchema, {
      version: 1,
      projects: [],
      workItems: [],
      comments: [],
      runs: [],
      settings: {
        projectManager: { provider: 'ollama', model: '', systemPrompt: 'Project Manager' },
        worker: { provider: 'ollama', model: '', systemPrompt: 'Worker' },
        reviewer: { provider: 'ollama', model: '', systemPrompt: 'Reviewer' },
        maxReviewRetries: 5,
        autoCommit: true,
        shellDenylist: ['rm'],
        shellAllowlist: [],
        forbiddenPathPatterns: [],
        timeoutMs: 300000,
      },
    })

    expect(parsed.settings.maxConcurrentRuns).toBe(2)
  })

  it('explains dirty git files before starting a work item', () => {
    expect(formatDirtyWorktreeStartMessage('BC-1', [
      '?? podcasts/',
      ' M src/main.ts',
      ' D old.txt',
    ])).toBe([
      'BC-1 작업을 시작하기 전에 확인이 필요해.',
      '',
      '원본 프로젝트 폴더에 아직 git으로 커밋되지 않은 파일이 있어. AIRI는 별도 worktree에서 작업하지만, 사용자 변경사항을 덮어쓰지 않기 위해 먼저 멈췄어.',
      '',
      '감지된 파일:',
      '- podcasts/ (추적되지 않음)',
      '- src/main.ts (수정됨)',
      '- old.txt (삭제됨)',
      '',
      '이 파일들이 네가 의도한 변경사항이면 "BC-1 계속 진행해도 돼"라고 말해줘. 원치 않는 파일이면 먼저 정리한 뒤 다시 시작해줘.',
    ].join('\n'))
  })
})
