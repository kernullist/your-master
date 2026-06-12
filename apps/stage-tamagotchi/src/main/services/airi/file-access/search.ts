/**
 * Pure helpers for the recursive file search tool. Kept free of `electron`/fs
 * imports so they stay unit-testable; the service does the actual fs walk.
 */

/** Max matches returned to the model. */
export const SEARCH_MAX_MATCHES = 50

/** Max files visited before the walk gives up (runaway-tree guard). */
export const SEARCH_MAX_FILES_VISITED = 5000

/** Max directory depth descended. */
export const SEARCH_MAX_DEPTH = 8

/** Max bytes read per file for content search. */
export const SEARCH_MAX_FILE_BYTES = 1024 * 1024

/** Max length of a returned matching line. */
export const SEARCH_MAX_LINE_CHARS = 200

/** Directories never descended (noise / huge / not user documents). */
export const SEARCH_SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '$recycle.bin',
  'system volume information',
  '.cache',
  'dist',
  'out',
  'build',
])

// NOTICE:
// Content search reads files as text; restrict to extensions that are plausibly
// text so we never slurp a multi-GB binary. Extensionless files are skipped for
// content search (still matchable by name).
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'rtf',
  'csv',
  'tsv',
  'log',
  'json',
  'json5',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'js',
  'jsx',
  'ts',
  'tsx',
  'vue',
  'svelte',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cs',
  'php',
  'sh',
  'ps1',
  'bat',
  'sql',
])

/** Whether a directory name should be skipped during the walk. */
export function shouldSkipDirectory(name: string): boolean {
  return SEARCH_SKIP_DIRECTORIES.has(name.toLowerCase())
}

/** Whether a filename is plausibly text and worth reading for content search. */
export function isSearchableTextFile(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) {
    return false
  }
  return TEXT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/** Case-insensitive substring match for filename search. */
export function matchesName(fileName: string, query: string): boolean {
  return fileName.toLowerCase().includes(query.toLowerCase())
}

/**
 * Finds content matches within one file's text.
 *
 * Before:
 * - content = "alpha\nBeta contract\ngamma", query = "contract"
 *
 * After:
 * - [{ line: 2, text: "Beta contract" }]
 *
 * Case-insensitive; returns at most `limit` hits with line text trimmed to
 * {@link SEARCH_MAX_LINE_CHARS}.
 */
export function findContentMatches(content: string, query: string, limit: number): { line: number, text: string }[] {
  const needle = query.toLowerCase()
  const out: { line: number, text: string }[] = []
  const lines = content.split('\n')

  for (let index = 0; index < lines.length && out.length < limit; index += 1) {
    if (lines[index].toLowerCase().includes(needle)) {
      const trimmed = lines[index].trim()
      out.push({
        line: index + 1,
        text: trimmed.length > SEARCH_MAX_LINE_CHARS ? `${trimmed.slice(0, SEARCH_MAX_LINE_CHARS)}…` : trimmed,
      })
    }
  }

  return out
}

/** Validates the search query. Returns an error message, or undefined. */
export function validateSearchQuery(query: string): string | undefined {
  const trimmed = query?.trim()
  if (!trimmed) {
    return 'query is required'
  }
  if (trimmed.length < 2) {
    return 'query must be at least 2 characters'
  }
  return undefined
}
