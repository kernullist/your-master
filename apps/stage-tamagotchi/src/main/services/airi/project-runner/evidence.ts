import type { WorkerAgentResult } from './review-loop'
import type { ProjectValidationCommandResult } from './tests'
import type { ProjectSourceFileIntelligence } from './tools'

import { errorMessageFrom } from '@moeru/std'

import { inspectProjectSourceFile } from './tools'

/**
 * Compact evidence bundle sent to the reviewer before model inspection begins.
 */
export interface ProjectReviewerEvidencePack {
  /** Files changed by the worker attempt. */
  changedFiles: string[]
  /** Worker comment and summary. */
  workerComment: string
  /** Worker evidence mapped to acceptance criteria. */
  acceptanceEvidence: WorkerAgentResult['acceptanceEvidence']
  /** Worker subtask progress, when the manager decomposed the job. */
  subtaskProgress: WorkerAgentResult['subtaskProgress']
  /** Diff summary visible to the reviewer. */
  diffSummary: string
  /** Validation summary visible to the reviewer. */
  testSummary?: string
  /** Structured, harness-executed validation exit codes the reviewer can trust over worker narrative. */
  validationResults?: ProjectValidationCommandResult[]
  /** AST-backed source intelligence for touched source files. */
  sourceFiles: ProjectSourceFileIntelligence[]
  /** Non-fatal collection failures. */
  warnings: string[]
}

const MAX_EVIDENCE_SOURCE_FILES = 8

/**
 * Builds a reviewer-specific evidence pack from worker output and touched files.
 *
 * Use when:
 * - Reviewer prompts need grounded file, import, symbol, diff, and validation evidence
 * - AIRI should reduce reviewer guesswork before asking for a pass/fail decision
 *
 * Expects:
 * - Changed files are project-relative paths from the active worktree/root
 * - Missing or deleted files should become warnings, not hard failures
 *
 * Returns:
 * - A compact evidence pack ready for prompt formatting
 */
export async function buildProjectReviewerEvidencePack(params: {
  forbiddenPathPatterns: string[]
  projectRoot: string
  workerResult: WorkerAgentResult
}): Promise<ProjectReviewerEvidencePack> {
  const warnings: string[] = []
  const sourceFiles: ProjectSourceFileIntelligence[] = []
  const sourceFilePaths = params.workerResult.changedFiles
    .filter(isSourcePath)
    .slice(0, MAX_EVIDENCE_SOURCE_FILES)

  for (const file of sourceFilePaths) {
    try {
      sourceFiles.push(await inspectProjectSourceFile({
        projectRoot: params.projectRoot,
        relativePath: file,
        forbiddenPathPatterns: params.forbiddenPathPatterns,
        maxSymbols: 40,
      }))
    }
    catch (error) {
      warnings.push(`${file}: ${errorMessageFrom(error) ?? 'source intelligence unavailable'}`)
    }
  }

  return {
    changedFiles: params.workerResult.changedFiles,
    workerComment: params.workerResult.comment,
    acceptanceEvidence: params.workerResult.acceptanceEvidence,
    subtaskProgress: params.workerResult.subtaskProgress,
    diffSummary: params.workerResult.diffSummary,
    testSummary: params.workerResult.testSummary,
    validationResults: params.workerResult.validationResults,
    sourceFiles,
    warnings,
  }
}

/**
 * Formats one executed validation command result as a trusted exit-code line.
 *
 * Before:
 * - `{ command: "pnpm test", exitCode: 1, timedOut: false }`
 *
 * After:
 * - "pnpm test -> exit 1"
 */
function formatValidationResult(result: ProjectValidationCommandResult): string {
  const timedOut = result.timedOut ? ' (timed out)' : ''
  return `${result.command} -> exit ${result.exitCode ?? 'null'}${timedOut}`
}

/**
 * Formats reviewer evidence for a model prompt.
 *
 * Use when:
 * - The reviewer agent needs compact, deterministic context
 * - Tool results should be summarized before the reviewer chooses deeper reads
 *
 * Expects:
 * - The pack was produced by {@link buildProjectReviewerEvidencePack}
 *
 * Returns:
 * - Human-readable evidence sections with empty sections omitted
 */
export function formatProjectReviewerEvidencePack(pack: ProjectReviewerEvidencePack): string {
  return [
    // Trusted, harness-executed signal comes first so the reviewer weighs exit codes over narrative.
    formatList('Executed validation (trusted exit codes)', pack.validationResults ?? [], formatValidationResult),
    formatList('Changed files', pack.changedFiles, item => item),
    formatList('Worker acceptance claims (unverified - re-derive from diff and executed validation)', pack.acceptanceEvidence ?? [], item => `[${item.status}] ${item.criterion}: ${item.evidence}`),
    formatList('Worker subtask progress', pack.subtaskProgress ?? [], item => `[${item.status}] ${item.title}${item.evidence ? `: ${item.evidence}` : ''}`),
    pack.workerComment ? `Worker comment (unverified):\n${pack.workerComment}` : '',
    pack.diffSummary ? `Diff summary:\n${pack.diffSummary}` : '',
    pack.testSummary ? `Validation summary:\n${pack.testSummary}` : '',
    formatList('Touched source symbols', pack.sourceFiles.flatMap(file =>
      file.symbols.map(symbol => `${symbol.path}:${symbol.line} ${symbol.exported ? 'exported ' : ''}${symbol.kind} ${symbol.name}`),
    ), item => item),
    formatList('Touched source imports', pack.sourceFiles.flatMap(file =>
      file.imports.map(importEntry => `${importEntry.path}:${importEntry.line} ${importEntry.typeOnly ? 'type ' : ''}from ${importEntry.source} ${importEntry.specifiers.join(', ')}`.trim()),
    ), item => item),
    formatList('Evidence warnings', [
      ...pack.warnings,
      ...pack.sourceFiles.flatMap(file => file.warnings.map(warning => `${file.path}: ${warning}`)),
    ], item => item),
  ].filter(Boolean).join('\n\n')
}

function formatList<T>(title: string, items: T[], format: (item: T) => string): string {
  if (items.length === 0)
    return ''

  return `${title}:\n${items.map(item => `- ${format(item)}`).join('\n')}`
}

function isSourcePath(path: string): boolean {
  return /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx|vue)$/.test(path)
}
