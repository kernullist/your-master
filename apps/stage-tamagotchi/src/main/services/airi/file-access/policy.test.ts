import { describe, expect, it } from 'vitest'

import {
  applyStringEdit,
  buildLineDiff,
  buildWritePreview,
  DIFF_PREVIEW_MAX_LINES,
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

describe('applyStringEdit', () => {
  it('replaces a unique match', () => {
    const result = applyStringEdit('const a = 1\nconst b = 2', 'const b = 2', 'const b = 3')
    expect(result.ok).toBe(true)
    expect(result.result).toBe('const a = 1\nconst b = 3')
  })

  it('supports deletion via empty newString', () => {
    const result = applyStringEdit('keep\nremove me\nkeep', 'remove me\n', '')
    expect(result.ok).toBe(true)
    expect(result.result).toBe('keep\nkeep')
  })

  it('rejects empty oldString (use file_write)', () => {
    expect(applyStringEdit('abc', '', 'x').error).toContain('file_write')
  })

  it('rejects a no-op edit', () => {
    expect(applyStringEdit('abc', 'abc', 'abc').error).toContain('identical')
  })

  it('rejects a missing target', () => {
    expect(applyStringEdit('abc', 'xyz', 'q').error).toContain('not found')
  })

  it('rejects an ambiguous target appearing more than once', () => {
    expect(applyStringEdit('foo foo', 'foo', 'bar').error).toContain('multiple')
  })
})

describe('buildLineDiff', () => {
  it('marks changed lines and keeps unchanged ones as context', () => {
    expect(buildLineDiff('a\nb\nc', 'a\nB\nc')).toBe('  a\n- b\n+ B\n  c')
  })

  it('shows pure additions and deletions', () => {
    expect(buildLineDiff('a', 'a\nb')).toBe('  a\n+ b')
    expect(buildLineDiff('a\nb', 'a')).toBe('  a\n- b')
  })

  it('caps very large diffs with a remainder note', () => {
    const before = ''
    const after = Array.from({ length: DIFF_PREVIEW_MAX_LINES + 20 }, (_, i) => `line ${i}`).join('\n')
    const diff = buildLineDiff(before, after)
    expect(diff).toContain('more diff lines')
  })
})
