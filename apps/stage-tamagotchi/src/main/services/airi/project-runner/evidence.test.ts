import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildProjectReviewerEvidencePack, formatProjectReviewerEvidencePack } from './evidence'

async function withTempProject<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'airi-project-evidence-'))
  try {
    return await fn(root)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('project reviewer evidence pack', () => {
  it('collects touched source symbols and formats worker evidence', async () => {
    await withTempProject(async (root) => {
      await writeFile(join(root, 'src.ts'), [
        'import { ref } from "vue"',
        'export function useDemo() {',
        '  return ref(1)',
        '}',
        '',
      ].join('\n'))

      const pack = await buildProjectReviewerEvidencePack({
        projectRoot: root,
        forbiddenPathPatterns: [],
        workerResult: {
          changedFiles: ['src.ts'],
          comment: 'Updated composable',
          diffSummary: 'src.ts changed',
          validationResults: [
            { command: 'pnpm typecheck', exitCode: 0, timedOut: false },
            { command: 'pnpm test', exitCode: 1, timedOut: false },
          ],
          acceptanceEvidence: [{
            criterion: 'Composable returns a ref',
            status: 'satisfied',
            evidence: 'src.ts exports useDemo.',
          }],
          subtaskProgress: [{
            title: 'Inspect source',
            status: 'done',
            evidence: 'src.ts',
          }],
        },
      })
      const formatted = formatProjectReviewerEvidencePack(pack)

      expect(pack.sourceFiles[0]?.symbols.map(symbol => symbol.name)).toContain('useDemo')
      // Worker acceptance is presented as an unverified claim so the reviewer re-derives it.
      expect(formatted).toContain('Worker acceptance claims (unverified')
      expect(formatted).toContain('Touched source imports')
      expect(formatted).toContain('from vue ref')
      // Executed validation exit codes appear as trusted ground truth.
      expect(formatted).toContain('Executed validation (trusted exit codes)')
      expect(formatted).toContain('pnpm test -> exit 1')
      expect(formatted).toContain('pnpm typecheck -> exit 0')
    })
  })
})
