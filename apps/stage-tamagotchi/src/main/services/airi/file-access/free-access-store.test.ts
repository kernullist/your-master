import { describe, expect, it } from 'vitest'

import { normalizeFreeAccessPaths } from './free-access-store'

describe('normalizeFreeAccessPaths', () => {
  it('drops empty, relative, and blocked entries', () => {
    expect(normalizeFreeAccessPaths([
      '',
      '  ',
      'relative\\path',
      'C:\\Windows\\System32',
      'C:\\Users\\me\\Notes',
    ])).toEqual(['C:\\Users\\me\\Notes'])
  })

  it('deduplicates case-insensitively and strips trailing separators on Windows', () => {
    if (process.platform !== 'win32') {
      return
    }

    expect(normalizeFreeAccessPaths([
      'C:\\Users\\me\\Notes\\',
      'c:\\users\\me\\notes',
      'D:\\work',
    ])).toEqual([
      'C:\\Users\\me\\Notes',
      'D:\\work',
    ])
  })
})
