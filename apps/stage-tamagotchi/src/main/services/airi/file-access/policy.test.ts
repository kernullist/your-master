import { describe, expect, it } from 'vitest'

import {
  buildWritePreview,
  isProbablyBinary,
  validateRequestPath,
  WRITE_PREVIEW_MAX_CHARS,
  writeBlockReason,
} from './policy'

describe('validateRequestPath', () => {
  it('rejects empty and whitespace paths', () => {
    expect(validateRequestPath('')).toContain('required')
    expect(validateRequestPath('   ')).toContain('required')
  })

  it('rejects relative paths', () => {
    expect(validateRequestPath('notes.txt')).toContain('absolute')
    expect(validateRequestPath('..\\secrets.txt')).toContain('absolute')
  })

  it('rejects UNC network paths', () => {
    expect(validateRequestPath('\\\\server\\share\\file.txt')).toContain('UNC')
  })

  it('accepts absolute Windows paths', () => {
    expect(validateRequestPath('C:\\Users\\me\\notes.txt')).toBeUndefined()
  })
})

describe('writeBlockReason', () => {
  it('blocks writes into OS and program directories regardless of case', () => {
    expect(writeBlockReason('C:\\Windows\\System32\\drivers\\etc\\hosts')).toContain('blocked')
    expect(writeBlockReason('c:\\program files\\app\\config.ini')).toContain('blocked')
    expect(writeBlockReason('C:\\Program Files (x86)\\tool\\a.txt')).toContain('blocked')
    expect(writeBlockReason('C:\\ProgramData\\svc\\state.json')).toContain('blocked')
  })

  it('normalizes traversal segments before matching', () => {
    expect(writeBlockReason('C:\\Users\\me\\..\\..\\Windows\\evil.dll')).toContain('blocked')
  })

  it('allows user directories', () => {
    expect(writeBlockReason('C:\\Users\\me\\Documents\\todo.md')).toBeUndefined()
    expect(writeBlockReason('F:\\kernullist\\notes.txt')).toBeUndefined()
  })
})

describe('isProbablyBinary', () => {
  it('flags buffers containing NUL bytes', () => {
    expect(isProbablyBinary(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x00, 0x0D]))).toBe(true)
  })

  it('accepts plain UTF-8 text', () => {
    expect(isProbablyBinary(new TextEncoder().encode('hello 한국어 텍스트\nline 2'))).toBe(false)
  })

  it('accepts empty buffers', () => {
    expect(isProbablyBinary(new Uint8Array())).toBe(false)
  })
})

describe('buildWritePreview', () => {
  it('keeps short content as-is', () => {
    expect(buildWritePreview('short')).toBe('short')
  })

  it('truncates long content with a character count note', () => {
    const long = 'x'.repeat(WRITE_PREVIEW_MAX_CHARS + 250)
    const preview = buildWritePreview(long)
    expect(preview).toContain('250 more characters')
    expect(preview.length).toBeLessThan(long.length)
  })
})
