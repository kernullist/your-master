import { describe, expect, it } from 'vitest'

import { clampOutput, COMMAND_OUTPUT_MAX_BYTES, commandBlockReason, validateCwd } from './policy'

describe('commandBlockReason', () => {
  it('requires a non-empty command', () => {
    expect(commandBlockReason('')).toContain('required')
    expect(commandBlockReason('   ')).toContain('required')
  })

  it('blocks destructive disk and filesystem commands', () => {
    expect(commandBlockReason('format C: /q')).toContain('blocked')
    expect(commandBlockReason('diskpart')).toContain('blocked')
    expect(commandBlockReason('rd /s /q C:\\temp')).toContain('blocked')
    expect(commandBlockReason('del /s *.tmp')).toContain('blocked')
  })

  it('blocks recursive force deletes in both shells', () => {
    expect(commandBlockReason('rm -rf /')).toContain('blocked')
    expect(commandBlockReason('Remove-Item -Recurse -Force C:\\data')).toContain('blocked')
    expect(commandBlockReason('Remove-Item -Force -Recurse C:\\data')).toContain('blocked')
  })

  it('blocks registry, firewall, antivirus and power commands', () => {
    expect(commandBlockReason('reg delete HKLM\\Software\\X /f')).toContain('blocked')
    expect(commandBlockReason('shutdown /s /t 0')).toContain('blocked')
    expect(commandBlockReason('Stop-Computer')).toContain('blocked')
    expect(commandBlockReason('netsh advfirewall firewall add rule ...')).toContain('blocked')
    expect(commandBlockReason('Set-MpPreference -DisableRealtimeMonitoring $true')).toContain('blocked')
  })

  it('blocks ransomware-style shadow copy deletion', () => {
    expect(commandBlockReason('vssadmin delete shadows /all /quiet')).toContain('blocked')
  })

  it('allows ordinary, safe commands', () => {
    expect(commandBlockReason('dir /b')).toBeUndefined()
    expect(commandBlockReason('code .')).toBeUndefined()
    expect(commandBlockReason('git status')).toBeUndefined()
    expect(commandBlockReason('npm run build')).toBeUndefined()
    expect(commandBlockReason('echo hello')).toBeUndefined()
  })
})

describe('validateCwd', () => {
  it('accepts no cwd', () => {
    expect(validateCwd(undefined)).toBeUndefined()
    expect(validateCwd('')).toBeUndefined()
  })

  it('rejects relative cwd', () => {
    expect(validateCwd('subdir')).toContain('absolute')
  })

  it('accepts absolute cwd', () => {
    expect(validateCwd('C:\\Users\\me\\project')).toBeUndefined()
  })
})

describe('clampOutput', () => {
  it('keeps short output as-is', () => {
    expect(clampOutput('hello')).toBe('hello')
  })

  it('truncates output past the cap with a marker', () => {
    const big = 'x'.repeat(COMMAND_OUTPUT_MAX_BYTES + 1000)
    const out = clampOutput(big)
    expect(out).toContain('output truncated')
    expect(out.length).toBeLessThan(big.length)
  })
})
