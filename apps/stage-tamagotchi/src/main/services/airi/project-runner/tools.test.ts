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
