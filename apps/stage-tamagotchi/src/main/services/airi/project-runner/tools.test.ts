import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  applyStructuredProjectPatch,
  findProjectFiles,
  indexProjectSymbols,
  inspectProjectSourceFile,
  listProjectDirectory,
  readProjectFile,
  replaceInProjectFile,
  resolveProjectToolPath,
  runProjectShellCommand,
  searchProjectFiles,
  writeProjectFile,
} from './tools'

async function withTempProject<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'airi-project-runner-'))
  try {
    return await fn(root)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('project runner tools', () => {
  it('rejects paths outside the project root', async () => {
    await withTempProject(async (root) => {
      expect(() => resolveProjectToolPath(root, '../outside.txt')).toThrow('Path escapes project root')
    })
  })

  it('lists, reads, searches, and patches project files', async () => {
    await withTempProject(async (root) => {
      await writeFile(join(root, 'task.txt'), 'hello AIRI\n')

      const entries = await listProjectDirectory({ projectRoot: root })
      const content = await readProjectFile({ projectRoot: root, relativePath: 'task.txt' })
      const matches = await searchProjectFiles({ projectRoot: root, query: 'AIRI' })
      const fileMatches = await findProjectFiles({ projectRoot: root, query: 'task' })
      const patched = await replaceInProjectFile({
        projectRoot: root,
        relativePath: 'task.txt',
        search: 'hello AIRI',
        replace: 'hello worker',
      })
      const nextContent = await readProjectFile({ projectRoot: root, relativePath: 'task.txt' })

      expect(entries).toEqual([{ path: 'task.txt', type: 'file' }])
      expect(content).toBe('hello AIRI\n')
      expect(matches).toEqual([{ path: 'task.txt', line: 1, text: 'hello AIRI' }])
      expect(fileMatches).toEqual([{ path: 'task.txt' }])
      expect(patched.replacements).toBe(1)
      expect(patched.path).toBe('task.txt')
      expect(nextContent).toBe('hello worker\n')
    })
  })

  it('ranks definitions above references and demotes test files in search', async () => {
    await withTempProject(async (root) => {
      await writeFile(join(root, 'widget.ts'), 'import { thing } from \'./thing\'\nexport function widget() {\n  return thing()\n}\n')
      await writeFile(join(root, 'widget.test.ts'), 'import { widget } from \'./widget\'\nwidget()\n')

      const matches = await searchProjectFiles({ projectRoot: root, query: 'widget' })

      // The declaration line ranks first; the *.test.ts reference is demoted below source references.
      expect(matches[0]).toEqual({ path: 'widget.ts', line: 2, text: 'export function widget() {' })
      expect(matches.at(-1)?.path).toBe('widget.test.ts')
    })
  })

  it('supports regex search and trims very long match lines', async () => {
    await withTempProject(async (root) => {
      const longTail = 'x'.repeat(400)
      await writeFile(join(root, 'code.ts'), `const handleClick = () => {}\nconst value = '${longTail}' // handleHover\n`)

      const matches = await searchProjectFiles({ projectRoot: root, query: 'handle(Click|Hover)', regex: true })

      expect(matches.map(match => match.line)).toEqual([1, 2])
      // The long line is truncated with a marker so it cannot flood the context window.
      const longMatch = matches.find(match => match.line === 2)
      expect(longMatch?.text).toContain('...[+')
      expect(longMatch?.text.length).toBeLessThan(300)
    })
  })

  it('falls back to literal search when a regex is invalid', async () => {
    await withTempProject(async (root) => {
      await writeFile(join(root, 'weird.ts'), 'const a = b[1  // unbalanced bracket text\n')

      // "[1" is an invalid regex; it must fall back to literal matching instead of throwing.
      const matches = await searchProjectFiles({ projectRoot: root, query: '[1', regex: true })

      expect(matches).toEqual([{ path: 'weird.ts', line: 1, text: 'const a = b[1  // unbalanced bracket text' }])
    })
  })

  it('replaces across CRLF drift with the line-trimmed fallback', async () => {
    await withTempProject(async (root) => {
      // File uses CRLF; the model supplies an LF search block that cannot exact-match.
      await writeFile(join(root, 'crlf.ts'), 'const a = 1\r\nconst b = 2\r\n')

      const result = await replaceInProjectFile({
        projectRoot: root,
        relativePath: 'crlf.ts',
        search: 'const a = 1\nconst b = 2',
        replace: 'const a = 10\nconst b = 20',
      })
      const updated = await readProjectFile({ projectRoot: root, relativePath: 'crlf.ts' })

      expect(result.replacements).toBe(1)
      expect(updated).toContain('const a = 10')
      expect(updated).toContain('const b = 20')
    })
  })

  it('refuses an ambiguous whitespace-insensitive match instead of editing the wrong block', async () => {
    await withTempProject(async (root) => {
      // Two identical CRLF blocks; an LF search matches both only after whitespace normalization.
      const original = 'foo()\r\nbar()\r\nfoo()\r\nbar()\r\n'
      await writeFile(join(root, 'dup.ts'), original)

      await expect(replaceInProjectFile({
        projectRoot: root,
        relativePath: 'dup.ts',
        search: 'foo()\nbar()',
        replace: 'baz()',
      })).rejects.toThrow('whitespace-insensitive')

      const unchanged = await readProjectFile({ projectRoot: root, relativePath: 'dup.ts' })
      expect(unchanged).toBe(original)
    })
  })

  it('applies a whitespace-insensitive replaceAll across drifted blocks', async () => {
    await withTempProject(async (root) => {
      await writeFile(join(root, 'multi.ts'), 'a()\r\nb()\r\na()\r\nb()\r\n')

      const result = await replaceInProjectFile({
        projectRoot: root,
        relativePath: 'multi.ts',
        search: 'a()\nb()',
        replace: 'c()',
        replaceAll: true,
      })
      const updated = await readProjectFile({ projectRoot: root, relativePath: 'multi.ts' })

      expect(result.replacements).toBe(2)
      expect(updated).not.toContain('a()')
      expect(updated).not.toContain('b()')
    })
  })

  it('writes nested project files without escaping the root', async () => {
    await withTempProject(async (root) => {
      const result = await writeProjectFile({
        projectRoot: root,
        relativePath: 'src/generated.txt',
        content: 'hello generated\n',
      })
      const content = await readProjectFile({ projectRoot: root, relativePath: 'src/generated.txt' })

      expect(result).toEqual({ path: 'src/generated.txt', writtenChars: 16 })
      expect(content).toBe('hello generated\n')
    })
  })

  it('applies structured patches across files and indexes source symbols', async () => {
    await withTempProject(async (root) => {
      await writeFile(join(root, 'src.ts'), [
        'export interface DemoOptions {}',
        'export function greet() {',
        '  return "hello"',
        '}',
        '',
      ].join('\n'))
      await writeFile(join(root, 'other.ts'), 'export const value = 1\n')

      const patch = await applyStructuredProjectPatch({
        projectRoot: root,
        files: [{
          path: 'src.ts',
          edits: [{
            search: 'return "hello"',
            replace: 'return "hi"',
          }],
        }, {
          path: 'other.ts',
          edits: [{
            search: '1',
            replace: '2',
          }],
        }],
      })
      const symbols = await indexProjectSymbols({ projectRoot: root })
      const nextSource = await readProjectFile({ projectRoot: root, relativePath: 'src.ts' })
      const nextOther = await readProjectFile({ projectRoot: root, relativePath: 'other.ts' })

      expect(patch.changedFiles).toEqual(['src.ts', 'other.ts'])
      expect(nextSource).toContain('return "hi"')
      expect(nextOther).toBe('export const value = 2\n')
      expect(symbols.map(symbol => `${symbol.kind}:${symbol.name}`)).toContain('interface:DemoOptions')
      expect(symbols.map(symbol => `${symbol.kind}:${symbol.name}`)).toContain('function:greet')
      expect(symbols.map(symbol => `${symbol.kind}:${symbol.name}`)).toContain('const:value')
      expect(symbols.find(symbol => symbol.name === 'greet')?.exported).toBe(true)
    })
  })

  it('extracts AST source intelligence for imports and Vue script symbols', async () => {
    await withTempProject(async (root) => {
      await writeFile(join(root, 'component.vue'), [
        '<template><div /></template>',
        '<script setup lang="ts">',
        'import { computed } from "vue"',
        'import type { DemoOptions } from "./types"',
        'const count = computed(() => 1)',
        '</script>',
        '',
      ].join('\n'))

      const intelligence = await inspectProjectSourceFile({
        projectRoot: root,
        relativePath: 'component.vue',
      })

      expect(intelligence.parseEngine).toBe('typescript-ast')
      expect(intelligence.imports.map(item => `${item.source}:${item.specifiers.join(',')}`)).toContain('vue:computed')
      expect(intelligence.imports.find(item => item.source === './types')?.typeOnly).toBe(true)
      expect(intelligence.symbols.map(symbol => `${symbol.kind}:${symbol.name}:${symbol.line}`)).toContain('const:count:5')
    })
  })

  it('skips forbidden paths during broad project discovery', async () => {
    await withTempProject(async (root) => {
      await writeFile(join(root, '.env'), 'SECRET=AIRI\n')
      await writeFile(join(root, 'visible.ts'), 'export const visible = "AIRI"\n')

      // ROOT CAUSE:
      //
      // Broad search and indexing recurse through every child path. Forbidden
      // paths should be invisible to the worker, but the recursion used to call
      // the strict resolver on each child and fail the whole discovery when a
      // project contained files such as `.env`.
      //
      // We fixed this by skipping forbidden children before recursing.
      const matches = await searchProjectFiles({
        projectRoot: root,
        query: 'AIRI',
        forbiddenPathPatterns: ['.env'],
      })
      const fileMatches = await findProjectFiles({
        projectRoot: root,
        query: '.env',
        forbiddenPathPatterns: ['.env'],
      })
      const symbols = await indexProjectSymbols({
        projectRoot: root,
        forbiddenPathPatterns: ['.env'],
      })

      expect(matches).toEqual([{ path: 'visible.ts', line: 1, text: 'export const visible = "AIRI"' }])
      expect(fileMatches).toEqual([])
      expect(symbols.map(symbol => symbol.name)).toContain('visible')
      await expect(readProjectFile({
        projectRoot: root,
        relativePath: '.env',
        forbiddenPathPatterns: ['.env'],
      })).rejects.toThrow('Path is forbidden by project policy')
    })
  })

  it('validates structured patches before writing any file', async () => {
    await withTempProject(async (root) => {
      await writeFile(join(root, 'first.ts'), 'export const first = 1\n')
      await writeFile(join(root, 'second.ts'), 'export const second = 2\n')

      // ROOT CAUSE:
      //
      // Structured patches used to call replaceInProjectFile one edit at a
      // time. If a later file failed validation, earlier files were already
      // written and non-git projects could be left partially modified.
      //
      // We fixed this by validating every target file and edit in memory before
      // writing any changed file back to disk.
      await expect(applyStructuredProjectPatch({
        projectRoot: root,
        files: [{
          path: 'first.ts',
          edits: [{
            search: '1',
            replace: '10',
          }],
        }, {
          path: 'second.ts',
          edits: [{
            search: 'missing',
            replace: '20',
          }],
        }],
      })).rejects.toThrow('Patch search text was not found in second.ts')

      await expect(readProjectFile({ projectRoot: root, relativePath: 'first.ts' })).resolves.toBe('export const first = 1\n')
      await expect(readProjectFile({ projectRoot: root, relativePath: 'second.ts' })).resolves.toBe('export const second = 2\n')
    })
  })

  it('blocks denied shell commands before spawning', async () => {
    await withTempProject(async (root) => {
      await expect(runProjectShellCommand({
        projectRoot: root,
        command: 'rm -rf dist',
        settings: {
          shellAllowlist: [],
          shellDenylist: ['rm'],
          timeoutMs: 1000,
        },
      })).rejects.toThrow('Command includes denied token: rm')
    })
  })
})
