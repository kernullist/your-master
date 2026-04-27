import { describe, expect, it } from 'vitest'

import { defaultProjectAgentSettings } from '../types/agent-config.ts'
import { evaluateShellCommandPolicy, isPathAllowed } from './policy.ts'

describe('evaluateShellCommandPolicy', () => {
  it('denies dangerous commands by default', () => {
    expect(evaluateShellCommandPolicy('git reset --hard', defaultProjectAgentSettings).allowed).toBe(false)
    expect(evaluateShellCommandPolicy('pnpm test', defaultProjectAgentSettings).allowed).toBe(true)
  })

  it('honors allowlist when configured', () => {
    expect(evaluateShellCommandPolicy('pnpm test', { shellAllowlist: ['pnpm'], shellDenylist: [] }).allowed).toBe(true)
    expect(evaluateShellCommandPolicy('npm test', { shellAllowlist: ['pnpm'], shellDenylist: [] }).allowed).toBe(false)
  })
})

describe('isPathAllowed', () => {
  it('rejects paths containing forbidden fragments', () => {
    expect(isPathAllowed('src/index.ts', ['node_modules'])).toBe(true)
    expect(isPathAllowed('node_modules/pkg/index.js', ['node_modules'])).toBe(false)
  })
})
