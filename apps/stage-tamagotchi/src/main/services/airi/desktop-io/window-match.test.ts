import { describe, expect, it } from 'vitest'

import { selectWindowSource } from './window-match'

function win(name: string) {
  return { name }
}

describe('selectWindowSource', () => {
  it('matches a window title by case-insensitive substring', () => {
    // ROOT CAUSE:
    //
    // The screenshot tool ignored any target and always captured sources[0] of
    // type 'screen', so "screenshot the VMware window" produced a full-screen
    // grab. selectWindowSource resolves a title query to the right window.
    const sources = [win('Google Chrome'), win('VMware Workstation'), win('Notepad')]
    expect(selectWindowSource(sources, 'vmware')).toEqual(win('VMware Workstation'))
    expect(selectWindowSource(sources, 'CHROME')).toEqual(win('Google Chrome'))
  })

  it('prefers the shortest matching title (most specific match)', () => {
    const sources = [
      win('Project - VMware Workstation - Logs'),
      win('VMware'),
      win('VMware Workstation'),
    ]
    expect(selectWindowSource(sources, 'vmware')).toEqual(win('VMware'))
  })

  it('returns undefined when nothing matches or the query is empty', () => {
    const sources = [win('Chrome'), win('Notepad')]
    expect(selectWindowSource(sources, 'vmware')).toBeUndefined()
    expect(selectWindowSource(sources, '   ')).toBeUndefined()
    expect(selectWindowSource([], 'chrome')).toBeUndefined()
  })

  it('trims the query before matching', () => {
    const sources = [win('VMware Workstation')]
    expect(selectWindowSource(sources, '  vmware  ')).toEqual(win('VMware Workstation'))
  })
})
