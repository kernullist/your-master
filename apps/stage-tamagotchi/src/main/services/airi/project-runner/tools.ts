import type { ProjectAgentSettings } from '@proj-airi/stage-projects'
import type {
  ExportDeclaration,
  ImportDeclaration,
  ScriptKind,
  SourceFile,
  Statement,
  VariableDeclaration,
  VariableStatement,
} from 'typescript'

import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

import { errorMessageFrom } from '@moeru/std'
import { evaluateShellCommandPolicy, isPathAllowed } from '@proj-airi/stage-projects'

/**
 * Result returned after running a worker shell command.
 */
export interface ProjectShellResult {
  /** Process exit code, or null when the process was terminated by timeout/signal. */
  exitCode: number | null
  /** Captured stdout, truncated to the runner limit. */
  stdout: string
  /** Captured stderr, truncated to the runner limit. */
  stderr: string
  /** True when AIRI killed the process because it exceeded the configured timeout. */
  timedOut: boolean
}

/**
 * One text search match inside a project file.
 */
export interface ProjectSearchMatch {
  /** Project-relative file path. */
  path: string
  /** One-based line number. */
  line: number
  /** Matching line text. */
  text: string
}

/**
 * One directory entry visible to the worker.
 */
export interface ProjectDirectoryEntry {
  /** Project-relative entry path. */
  path: string
  /** File type used by AIRI to decide whether it can read or recurse. */
  type: 'file' | 'directory' | 'other'
}

/**
 * One project file matched by a filename query.
 */
export interface ProjectFileMatch {
  /** Project-relative file path. */
  path: string
}

/**
 * Coarse declaration kind used by the project source index.
 */
export type ProjectSymbolKind = 'class' | 'component' | 'const' | 'enum' | 'function' | 'interface' | 'type'

/**
 * One symbol-like declaration found in a text source file.
 */
export interface ProjectSymbolEntry {
  /** Project-relative file path. */
  path: string
  /** One-based line number where the declaration begins. */
  line: number
  /** Symbol name or best-effort label. */
  name: string
  /** Coarse declaration kind. */
  kind: ProjectSymbolKind
  /** Full source line used as evidence. */
  text: string
  /** Whether the declaration is exported from its module. */
  exported?: boolean
  /** Compact signature text when the parser can extract one. */
  signature?: string
}

/**
 * One import or re-export dependency discovered in a source file.
 */
export interface ProjectImportEntry {
  /** Project-relative file path. */
  path: string
  /** One-based line number where the import begins. */
  line: number
  /** Module specifier, for example `vue` or `./tools`. */
  source: string
  /** Imported, re-exported, namespace, default, or require-bound names. */
  specifiers: string[]
  /** True when the import clause is type-only. */
  typeOnly?: boolean
}

/**
 * Best-effort AST intelligence for one project source file.
 */
export interface ProjectSourceFileIntelligence {
  /** Project-relative file path. */
  path: string
  /** Language family inferred from the filename. */
  language: 'javascript' | 'typescript' | 'vue'
  /** Parser engine used for this file. */
  parseEngine: 'regex-fallback' | 'typescript-ast'
  /** Declaration symbols found in the file. */
  symbols: ProjectSymbolEntry[]
  /** Import and re-export dependencies found in the file. */
  imports: ProjectImportEntry[]
  /** Non-fatal parser warnings that explain incomplete intelligence. */
  warnings: string[]
}

/**
 * One exact text edit in a structured project patch.
 */
export interface ProjectPatchEdit {
  /** Text that must appear in the target file. */
  search: string
  /** Replacement text, including the empty string for deletions. */
  replace: string
  /** Whether every occurrence should be replaced. */
  replaceAll?: boolean
}

/**
 * Structured patch payload for one file.
 */
export interface ProjectPatchFile {
  /** Project-relative target file. */
  path: string
  /** Ordered edits applied to the file. */
  edits: ProjectPatchEdit[]
}

const DEFAULT_OUTPUT_LIMIT = 1024 * 256
const DEFAULT_SEARCH_LIMIT = 100
const DEFAULT_SYMBOL_LIMIT = 120
/** Longest match line returned before truncation, so minified/generated lines cannot flood the window. */
const DEFAULT_SEARCH_LINE_LENGTH = 240
const SKIPPED_SEARCH_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'out', '.turbo'])

type TypeScriptModule = typeof import('typescript')

let typeScriptModulePromise: Promise<TypeScriptModule | undefined> | undefined

/**
 * Resolves a project-relative path and rejects path traversal.
 *
 * Use when:
 * - Worker file tools receive a path from an LLM tool call
 * - The path must stay inside the registered project folder
 *
 * Expects:
 * - `projectRoot` is an absolute or process-resolvable local folder path
 *
 * Returns:
 * - Absolute path plus normalized project-relative path
 */
export function resolveProjectToolPath(
  projectRoot: string,
  relativePath: string,
  forbiddenPathPatterns: string[] = [],
): { absolutePath: string, relativePath: string } {
  const root = resolve(projectRoot)
  const absolutePath = resolve(root, relativePath || '.')
  const staysInsideRoot = absolutePath === root || absolutePath.startsWith(`${root}${sep}`)
  if (!staysInsideRoot)
    throw new Error(`Path escapes project root: ${relativePath}`)

  const normalizedRelativePath = relative(root, absolutePath).replace(/\\/g, '/') || '.'
  if (!isPathAllowed(normalizedRelativePath, forbiddenPathPatterns))
    throw new Error(`Path is forbidden by project policy: ${normalizedRelativePath}`)

  return {
    absolutePath,
    relativePath: normalizedRelativePath,
  }
}

/**
 * Lists a project directory without leaving the project root.
 *
 * Use when:
 * - Worker agent needs to discover nearby files before reading or patching
 *
 * Expects:
 * - Directory exists and is readable
 *
 * Returns:
 * - Sorted project-relative entries with coarse file type
 */
export async function listProjectDirectory(params: {
  projectRoot: string
  relativePath?: string
  forbiddenPathPatterns?: string[]
}): Promise<ProjectDirectoryEntry[]> {
  const target = resolveProjectToolPath(params.projectRoot, params.relativePath ?? '.', params.forbiddenPathPatterns)
  const entries = await readdir(target.absolutePath, { withFileTypes: true })
  return entries
    .map((entry): ProjectDirectoryEntry => ({
      path: target.relativePath === '.' ? entry.name : `${target.relativePath}/${entry.name}`,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Reads one project file as UTF-8 text.
 *
 * Use when:
 * - Worker agent needs source context before generating a patch
 *
 * Expects:
 * - The target is a text file under the project root
 *
 * Returns:
 * - UTF-8 file contents
 */
export async function readProjectFile(params: {
  projectRoot: string
  relativePath: string
  forbiddenPathPatterns?: string[]
}): Promise<string> {
  const target = resolveProjectToolPath(params.projectRoot, params.relativePath, params.forbiddenPathPatterns)
  return await readFile(target.absolutePath, 'utf-8')
}

/**
 * Replaces an exact text fragment in one project file.
 *
 * Use when:
 * - Worker agent proposes a focused edit and AIRI needs deterministic patch behavior
 *
 * Expects:
 * - `search` appears exactly once unless `replaceAll` is true
 *
 * Returns:
 * - Project-relative normalized path and number of replacements applied
 */
export async function replaceInProjectFile(params: {
  projectRoot: string
  relativePath: string
  search: string
  replace: string
  replaceAll?: boolean
  forbiddenPathPatterns?: string[]
}): Promise<{ path: string, replacements: number }> {
  const target = resolveProjectToolPath(params.projectRoot, params.relativePath, params.forbiddenPathPatterns)
  const current = await readFile(target.absolutePath, 'utf-8')
  const result = applyExactTextEdits(current, target.relativePath, [{
    search: params.search,
    replace: params.replace,
    replaceAll: params.replaceAll,
  }])
  await writeFile(target.absolutePath, result.text)
  return {
    path: target.relativePath,
    replacements: result.replacements,
  }
}

/**
 * Splits text into lines with their absolute start offsets.
 *
 * Use when:
 * - A line-based match must map back to an exact character span in the original text
 *
 * Expects:
 * - `text` uses `\n` as the record separator; a trailing `\n` yields a final empty line
 *
 * Returns:
 * - One entry per line, each with its start offset and content excluding the newline
 */
function splitLinesWithOffsets(text: string): Array<{ start: number, text: string }> {
  const lines: Array<{ start: number, text: string }> = []
  let start = 0
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text[i] === '\n') {
      lines.push({ start, text: text.slice(start, i) })
      start = i + 1
    }
  }
  return lines
}

/**
 * Normalizes a line for whitespace-insensitive comparison.
 *
 * Before:
 * - "  return value  \r"
 *
 * After:
 * - "  return value"
 */
function normalizeLineEnd(line: string): string {
  // Strip a trailing carriage return, spaces, tabs, BOM, and non-breaking space so CRLF and
  // re-indentation drift do not block an otherwise-correct match. Leading indentation is kept.
  return line.replace(/\s+$/, '')
}

/**
 * Finds character spans that match `search` line by line, ignoring trailing whitespace and CRLF.
 *
 * Use when:
 * - An exact match failed and the model likely drifted on trailing whitespace or line endings
 *
 * Expects:
 * - `search` is compared as whole lines; a partial-line search will not match (fails safe)
 *
 * Returns:
 * - Original-text `{ start, end }` spans (end exclusive); empty when nothing matches
 */
function findLineTrimmedMatches(text: string, search: string): Array<{ start: number, end: number }> {
  const searchKeys = search.replace(/\r\n/g, '\n').split('\n').map(normalizeLineEnd)
  const windowSize = searchKeys.length
  if (windowSize === 0)
    return []

  const lines = splitLinesWithOffsets(text)
  const matches: Array<{ start: number, end: number }> = []
  for (let i = 0; i + windowSize <= lines.length; i += 1) {
    let matched = true
    for (let j = 0; j < windowSize; j += 1) {
      if (normalizeLineEnd(lines[i + j].text) !== searchKeys[j]) {
        matched = false
        break
      }
    }
    if (!matched)
      continue

    const lastLine = lines[i + windowSize - 1]
    matches.push({
      start: lines[i].start,
      end: lastLine.start + lastLine.text.length,
    })
  }
  return matches
}

function applyExactTextEdits(text: string, relativePath: string, edits: ProjectPatchEdit[]): { replacements: number, text: string } {
  let next = text
  let replacements = 0

  for (const edit of edits) {
    if (edit.search.length === 0)
      throw new Error(`Patch search text must not be empty in ${relativePath}`)

    const occurrences = next.split(edit.search).length - 1
    if (occurrences > 0) {
      if (occurrences > 1 && !edit.replaceAll)
        throw new Error(`Patch search text matched ${occurrences} times in ${relativePath}`)

      next = edit.replaceAll
        ? next.split(edit.search).join(edit.replace)
        : next.replace(edit.search, edit.replace)
      replacements += edit.replaceAll ? occurrences : 1
      continue
    }

    // NOTICE:
    // Exact match failed, so fall back to a line-trimmed match that ignores trailing whitespace
    // and CRLF, because models routinely drift on those. Uniqueness is still enforced so an
    // ambiguous fuzzy match fails loudly instead of silently editing the wrong location.
    const fuzzyMatches = findLineTrimmedMatches(next, edit.search)
    if (fuzzyMatches.length === 0)
      throw new Error(`Patch search text was not found in ${relativePath}`)
    if (fuzzyMatches.length > 1 && !edit.replaceAll)
      throw new Error(`Patch search text matched ${fuzzyMatches.length} times (whitespace-insensitive) in ${relativePath}`)

    const targets = edit.replaceAll ? fuzzyMatches : [fuzzyMatches[0]]
    // Apply from last to first so earlier spans keep their original offsets after each splice.
    for (let m = targets.length - 1; m >= 0; m -= 1) {
      next = next.slice(0, targets[m].start) + edit.replace + next.slice(targets[m].end)
    }
    replacements += targets.length
  }

  return {
    replacements,
    text: next,
  }
}

/**
 * Writes a complete UTF-8 file inside the project root.
 *
 * Use when:
 * - Worker agent needs to create a new file
 * - Exact replacement is too brittle for a generated whole-file rewrite
 *
 * Expects:
 * - The target path is allowed by project policy
 * - The worker has already read relevant surrounding context when overwriting
 *
 * Returns:
 * - The project-relative path and written character count
 */
export async function writeProjectFile(params: {
  content: string
  forbiddenPathPatterns?: string[]
  projectRoot: string
  relativePath: string
}): Promise<{ path: string, writtenChars: number }> {
  const target = resolveProjectToolPath(params.projectRoot, params.relativePath, params.forbiddenPathPatterns)
  await mkdir(dirname(target.absolutePath), { recursive: true })
  await writeFile(target.absolutePath, params.content)
  return {
    path: target.relativePath,
    writtenChars: params.content.length,
  }
}

/**
 * Applies ordered exact-text edits across one or more project files.
 *
 * Use when:
 * - Worker agent needs a deterministic multi-edit patch
 * - Review feedback asks for several related replacements in one attempt
 *
 * Expects:
 * - Each `search` appears exactly once unless `replaceAll` is true
 * - Every target path is project-relative and allowed by project policy
 *
 * Returns:
 * - Per-file replacement counts and total changed files
 */
export async function applyStructuredProjectPatch(params: {
  files: ProjectPatchFile[]
  forbiddenPathPatterns?: string[]
  projectRoot: string
}): Promise<{ files: Array<{ path: string, replacements: number }>, changedFiles: string[] }> {
  const prepared: Array<{ absolutePath: string, nextText: string, path: string, replacements: number }> = []

  for (const file of params.files) {
    const target = resolveProjectToolPath(params.projectRoot, file.path, params.forbiddenPathPatterns)
    const current = await readFile(target.absolutePath, 'utf-8')
    const result = applyExactTextEdits(current, target.relativePath, file.edits)
    prepared.push({
      absolutePath: target.absolutePath,
      nextText: result.text,
      path: target.relativePath,
      replacements: result.replacements,
    })
  }

  for (const file of prepared) {
    await writeFile(file.absolutePath, file.nextText)
  }

  return {
    files: prepared.map(file => ({
      path: file.path,
      replacements: file.replacements,
    })),
    changedFiles: [...new Set(prepared.map(result => result.path))],
  }
}

async function collectSearchFiles(params: {
  projectRoot: string
  relativePath: string
  forbiddenPathPatterns: string[]
  files: string[]
  maxFiles: number
}) {
  if (params.files.length >= params.maxFiles)
    return

  const target = resolveProjectToolPath(params.projectRoot, params.relativePath, params.forbiddenPathPatterns)
  const targetStat = await stat(target.absolutePath)
  if (targetStat.isFile()) {
    params.files.push(target.relativePath)
    return
  }
  if (!targetStat.isDirectory())
    return

  const entries = await readdir(target.absolutePath, { withFileTypes: true })
  for (const entry of entries) {
    if (params.files.length >= params.maxFiles)
      return
    if (entry.isDirectory() && SKIPPED_SEARCH_DIRECTORIES.has(entry.name))
      continue

    const childPath = target.relativePath === '.' ? entry.name : `${target.relativePath}/${entry.name}`
    if (!isPathAllowed(childPath, params.forbiddenPathPatterns))
      continue

    await collectSearchFiles({
      ...params,
      relativePath: childPath,
    })
  }
}

function isLikelySourceFile(path: string): boolean {
  return /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx|vue)$/.test(path)
}

function detectSourceLanguage(path: string): ProjectSourceFileIntelligence['language'] {
  if (path.endsWith('.vue'))
    return 'vue'
  if (/\.(?:cts|mts|ts|tsx)$/.test(path))
    return 'typescript'
  return 'javascript'
}

async function loadTypeScriptModule(): Promise<TypeScriptModule | undefined> {
  typeScriptModulePromise ??= import('typescript')
    .then(module => module)
    .catch(() => undefined)
  return await typeScriptModulePromise
}

function getTypeScriptScriptKind(ts: TypeScriptModule, path: string, text: string): ScriptKind {
  const lowerText = text.toLowerCase()
  const vueUsesTsx = path.endsWith('.vue') && (lowerText.includes('lang="tsx"') || lowerText.includes('lang=\'tsx\''))
  if (path.endsWith('.tsx') || vueUsesTsx)
    return ts.ScriptKind.TSX
  if (path.endsWith('.jsx'))
    return ts.ScriptKind.JSX
  if (/\.(?:js|mjs|cjs)$/.test(path))
    return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function preserveOnlyVueScriptBlocks(text: string): string {
  let next = ''
  let cursor = 0
  const scriptPattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null

  while ((match = scriptPattern.exec(text))) {
    const content = match[1] ?? ''
    const contentOffset = match[0].indexOf(content)
    if (contentOffset < 0)
      continue

    const contentStart = match.index + contentOffset
    next += text.slice(cursor, contentStart).replace(/[^\r\n]/g, ' ')
    next += content
    cursor = contentStart + content.length
  }

  next += text.slice(cursor).replace(/[^\r\n]/g, ' ')
  return next
}

function getSourceTextForParsing(path: string, text: string): string {
  return path.endsWith('.vue') ? preserveOnlyVueScriptBlocks(text) : text
}

function lineTextAt(text: string, line: number): string {
  return text.split(/\r?\n/)[line - 1]?.trim() ?? ''
}

function truncateSignature(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim()
  return singleLine.length > 180 ? `${singleLine.slice(0, 180)}...` : singleLine
}

function statementLine(sourceFile: SourceFile, statement: Statement): number {
  return sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1
}

function hasExportModifier(ts: TypeScriptModule, statement: Statement): boolean {
  if (!ts.canHaveModifiers(statement))
    return false

  return ts.getModifiers(statement)?.some(modifier =>
    modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword,
  ) ?? false
}

function isDefineComponentInitializer(ts: TypeScriptModule, declaration: VariableDeclaration): boolean {
  const initializer = declaration.initializer
  return !!initializer
    && ts.isCallExpression(initializer)
    && ts.isIdentifier(initializer.expression)
    && initializer.expression.text === 'defineComponent'
}

function variableName(ts: TypeScriptModule, declaration: VariableDeclaration): string | undefined {
  return ts.isIdentifier(declaration.name) ? declaration.name.text : undefined
}

function collectImportSpecifiers(ts: TypeScriptModule, node: ImportDeclaration | ExportDeclaration): string[] {
  if (ts.isImportDeclaration(node)) {
    const specifiers: string[] = []
    if (node.importClause?.name)
      specifiers.push(node.importClause.name.text)

    const namedBindings = node.importClause?.namedBindings
    if (namedBindings && ts.isNamespaceImport(namedBindings))
      specifiers.push(`* as ${namedBindings.name.text}`)
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        specifiers.push(element.propertyName ? `${element.propertyName.text} as ${element.name.text}` : element.name.text)
      }
    }

    return specifiers
  }

  const exportClause = node.exportClause
  if (!exportClause)
    return []
  if (ts.isNamespaceExport(exportClause))
    return [`* as ${exportClause.name.text}`]
  return exportClause.elements.map(element =>
    element.propertyName ? `${element.propertyName.text} as ${element.name.text}` : element.name.text,
  )
}

function collectImportsFromAst(ts: TypeScriptModule, path: string, sourceFile: SourceFile): ProjectImportEntry[] {
  const imports: ProjectImportEntry[] = []

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier
      if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier))
        continue

      imports.push({
        path,
        line: statementLine(sourceFile, statement),
        source: moduleSpecifier.text,
        specifiers: collectImportSpecifiers(ts, statement),
        typeOnly: ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly === true : false,
      })
      continue
    }

    if (!ts.isVariableStatement(statement))
      continue

    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer
      if (!initializer || !ts.isCallExpression(initializer))
        continue
      if (!ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'require')
        continue

      const [sourceArgument] = initializer.arguments
      if (!sourceArgument || !ts.isStringLiteralLike(sourceArgument))
        continue

      const name = variableName(ts, declaration)
      imports.push({
        path,
        line: statementLine(sourceFile, statement),
        source: sourceArgument.text,
        specifiers: name ? [name] : [],
      })
    }
  }

  return imports
}

function pushAstSymbol(params: {
  exported: boolean
  kind: ProjectSymbolKind
  maxSymbols: number
  name: string
  path: string
  sourceFile: SourceFile
  sourceText: string
  statement: Statement
  symbols: ProjectSymbolEntry[]
}): void {
  if (params.symbols.length >= params.maxSymbols)
    return

  const line = statementLine(params.sourceFile, params.statement)
  params.symbols.push({
    path: params.path,
    line,
    name: params.name,
    kind: params.kind,
    text: lineTextAt(params.sourceText, line),
    exported: params.exported,
    signature: truncateSignature(params.statement.getText(params.sourceFile).split(/\r?\n/)[0] ?? ''),
  })
}

function collectVariableSymbolsFromAst(params: {
  exported: boolean
  maxSymbols: number
  path: string
  sourceFile: SourceFile
  sourceText: string
  statement: VariableStatement
  symbols: ProjectSymbolEntry[]
  ts: TypeScriptModule
}): void {
  for (const declaration of params.statement.declarationList.declarations) {
    const name = variableName(params.ts, declaration)
    if (!name)
      continue

    pushAstSymbol({
      exported: params.exported,
      kind: isDefineComponentInitializer(params.ts, declaration) ? 'component' : 'const',
      maxSymbols: params.maxSymbols,
      name,
      path: params.path,
      sourceFile: params.sourceFile,
      sourceText: params.sourceText,
      statement: params.statement,
      symbols: params.symbols,
    })
  }
}

function collectSymbolsFromAst(ts: TypeScriptModule, path: string, sourceText: string, sourceFile: SourceFile, maxSymbols: number): ProjectSymbolEntry[] {
  const symbols: ProjectSymbolEntry[] = []

  for (const statement of sourceFile.statements) {
    if (symbols.length >= maxSymbols)
      break

    const exported = hasExportModifier(ts, statement)
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      pushAstSymbol({
        exported,
        kind: 'function',
        maxSymbols,
        name: statement.name.text,
        path,
        sourceFile,
        sourceText,
        statement,
        symbols,
      })
      continue
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      pushAstSymbol({
        exported,
        kind: 'class',
        maxSymbols,
        name: statement.name.text,
        path,
        sourceFile,
        sourceText,
        statement,
        symbols,
      })
      continue
    }

    if (ts.isInterfaceDeclaration(statement)) {
      pushAstSymbol({
        exported,
        kind: 'interface',
        maxSymbols,
        name: statement.name.text,
        path,
        sourceFile,
        sourceText,
        statement,
        symbols,
      })
      continue
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      pushAstSymbol({
        exported,
        kind: 'type',
        maxSymbols,
        name: statement.name.text,
        path,
        sourceFile,
        sourceText,
        statement,
        symbols,
      })
      continue
    }

    if (ts.isEnumDeclaration(statement)) {
      pushAstSymbol({
        exported,
        kind: 'enum',
        maxSymbols,
        name: statement.name.text,
        path,
        sourceFile,
        sourceText,
        statement,
        symbols,
      })
      continue
    }

    if (ts.isVariableStatement(statement)) {
      collectVariableSymbolsFromAst({
        exported,
        maxSymbols,
        path,
        sourceFile,
        sourceText,
        statement,
        symbols,
        ts,
      })
      continue
    }

    if (ts.isExportAssignment(statement)) {
      pushAstSymbol({
        exported: true,
        kind: 'component',
        maxSymbols,
        name: 'default',
        path,
        sourceFile,
        sourceText,
        statement,
        symbols,
      })
    }
  }

  return symbols
}

function collectSymbolsFromText(path: string, text: string, maxSymbols: number): ProjectSymbolEntry[] {
  const symbols: ProjectSymbolEntry[] = []
  const lines = text.split(/\r?\n/)

  for (const [index, line] of lines.entries()) {
    if (symbols.length >= maxSymbols)
      break

    const trimmed = line.trim()
    const match = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)
      ?? trimmed.match(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/)
      ?? trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/)
      ?? trimmed.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/)
      ?? trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/)
      ?? trimmed.match(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*defineComponent/)
    if (!match?.[1])
      continue

    const kind = trimmed.includes('defineComponent')
      ? 'component'
      : trimmed.includes('function ')
        ? 'function'
        : trimmed.includes('class ')
          ? 'class'
          : trimmed.includes('interface ')
            ? 'interface'
            : trimmed.includes('type ')
              ? 'type'
              : 'const'
    symbols.push({
      path,
      line: index + 1,
      name: match[1],
      kind,
      text: trimmed,
      exported: /^export\b/.test(trimmed),
    })
  }

  return symbols
}

function collectImportsFromText(path: string, text: string): ProjectImportEntry[] {
  const imports: ProjectImportEntry[] = []
  const lines = text.split(/\r?\n/)

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    const source = moduleSpecifierFromFallbackLine(trimmed)
    if (!source)
      continue

    imports.push({
      path,
      line: index + 1,
      source,
      specifiers: [],
      typeOnly: /^import\s+type\b/.test(trimmed),
    })
  }

  return imports
}

function moduleSpecifierFromFallbackLine(line: string): string | undefined {
  if (line.startsWith('import ')) {
    const fromIndex = line.lastIndexOf(' from ')
    return firstQuotedString(fromIndex >= 0 ? line.slice(fromIndex + 6) : line.slice('import '.length))
  }

  if (line.startsWith('export ')) {
    const fromIndex = line.lastIndexOf(' from ')
    if (fromIndex >= 0)
      return firstQuotedString(line.slice(fromIndex + 6))
  }

  const requireIndex = line.indexOf('require(')
  if (requireIndex >= 0)
    return firstQuotedString(line.slice(requireIndex + 'require('.length))

  return undefined
}

function firstQuotedString(value: string): string | undefined {
  const singleQuoteIndex = value.indexOf('\'')
  const doubleQuoteIndex = value.indexOf('"')
  const quoteIndex = [singleQuoteIndex, doubleQuoteIndex]
    .filter(index => index >= 0)
    .sort((a, b) => a - b)[0]
  if (quoteIndex === undefined)
    return undefined

  const quote = value[quoteIndex]
  const endIndex = value.indexOf(quote, quoteIndex + 1)
  return endIndex >= 0 ? value.slice(quoteIndex + 1, endIndex) : undefined
}

/**
 * Builds AST-backed source intelligence for one source file.
 *
 * Use when:
 * - Worker and reviewer agents need imports and symbols before editing
 * - Context packs need compact source-map style evidence
 *
 * Expects:
 * - The target file is UTF-8 readable and allowed by project policy
 *
 * Returns:
 * - Symbols, imports, parser engine, and warnings with regex fallback when TypeScript is unavailable
 */
export async function inspectProjectSourceFile(params: {
  forbiddenPathPatterns?: string[]
  maxSymbols?: number
  projectRoot: string
  relativePath: string
}): Promise<ProjectSourceFileIntelligence> {
  const text = await readProjectFile({
    projectRoot: params.projectRoot,
    relativePath: params.relativePath,
    forbiddenPathPatterns: params.forbiddenPathPatterns,
  })
  const sourceText = getSourceTextForParsing(params.relativePath, text)
  const language = detectSourceLanguage(params.relativePath)
  const maxSymbols = params.maxSymbols ?? DEFAULT_SYMBOL_LIMIT
  const warnings: string[] = []
  const ts = await loadTypeScriptModule()

  if (ts && sourceText.trim().length > 0) {
    try {
      const sourceFile = ts.createSourceFile(
        params.relativePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        getTypeScriptScriptKind(ts, params.relativePath, text),
      )
      return {
        path: params.relativePath,
        language,
        parseEngine: 'typescript-ast',
        symbols: collectSymbolsFromAst(ts, params.relativePath, sourceText, sourceFile, maxSymbols),
        imports: collectImportsFromAst(ts, params.relativePath, sourceFile),
        warnings,
      }
    }
    catch (error) {
      warnings.push(`typescript parser failed: ${errorMessageFrom(error) ?? 'unknown error'}`)
    }
  }

  if (!ts)
    warnings.push('typescript parser unavailable; used regex fallback')

  return {
    path: params.relativePath,
    language,
    parseEngine: 'regex-fallback',
    symbols: collectSymbolsFromText(params.relativePath, sourceText, maxSymbols),
    imports: collectImportsFromText(params.relativePath, sourceText),
    warnings,
  }
}

/**
 * Builds an AST-backed symbol index from common TypeScript/Vue/JavaScript files.
 *
 * Use when:
 * - Worker or reviewer agents need entry points before reading source files
 * - Context packs need compact exported symbol hints with parser fallback
 *
 * Expects:
 * - The project can be indexed best-effort with TypeScript AST or regex fallback
 *
 * Returns:
 * - Symbol-like declarations up to the provided limit
 */
export async function indexProjectSymbols(params: {
  forbiddenPathPatterns?: string[]
  maxFiles?: number
  maxSymbols?: number
  projectRoot: string
  relativePath?: string
}): Promise<ProjectSymbolEntry[]> {
  const files: string[] = []
  const symbols: ProjectSymbolEntry[] = []
  const maxSymbols = params.maxSymbols ?? DEFAULT_SYMBOL_LIMIT
  await collectSearchFiles({
    projectRoot: params.projectRoot,
    relativePath: params.relativePath ?? '.',
    forbiddenPathPatterns: params.forbiddenPathPatterns ?? [],
    files,
    maxFiles: params.maxFiles ?? 2000,
  })

  for (const file of files.filter(isLikelySourceFile)) {
    if (symbols.length >= maxSymbols)
      break

    try {
      const intelligence = await inspectProjectSourceFile({
        projectRoot: params.projectRoot,
        relativePath: file,
        forbiddenPathPatterns: params.forbiddenPathPatterns,
        maxSymbols: maxSymbols - symbols.length,
      })
      symbols.push(...intelligence.symbols)
    }
    catch {
      continue
    }
  }

  return symbols
}

/**
 * Finds project files by project-relative path substring.
 *
 * Use when:
 * - Worker agent knows a likely filename but not its folder
 * - A lighter filename search is enough before reading files
 *
 * Expects:
 * - The query is matched case-insensitively against normalized relative paths
 *
 * Returns:
 * - Matching file paths up to the provided limit
 */
export async function findProjectFiles(params: {
  forbiddenPathPatterns?: string[]
  maxFiles?: number
  projectRoot: string
  query: string
  relativePath?: string
}): Promise<ProjectFileMatch[]> {
  const files: string[] = []
  await collectSearchFiles({
    projectRoot: params.projectRoot,
    relativePath: params.relativePath ?? '.',
    forbiddenPathPatterns: params.forbiddenPathPatterns ?? [],
    files,
    maxFiles: params.maxFiles ?? 2000,
  })

  const query = params.query.trim().toLowerCase()
  return files
    .filter(file => file.toLowerCase().includes(query))
    .slice(0, params.maxFiles ?? DEFAULT_SEARCH_LIMIT)
    .map(path => ({ path }))
}

/** Truncates an over-long match line so a single minified/generated line cannot flood the context window. */
function trimSearchLine(line: string): string {
  if (line.length <= DEFAULT_SEARCH_LINE_LENGTH)
    return line
  return `${line.slice(0, DEFAULT_SEARCH_LINE_LENGTH)} ...[+${line.length - DEFAULT_SEARCH_LINE_LENGTH} chars]`
}

/**
 * Builds a per-line matcher for literal or regular-expression search.
 *
 * Use when:
 * - searchProjectFiles needs to test each line against a query
 *
 * Expects:
 * - `useRegex` compiles `query` as a RegExp; an invalid pattern safely falls back to literal search
 *
 * Returns:
 * - A predicate that reports whether a line matches
 */
function createLineMatcher(query: string, useRegex: boolean): (line: string) => boolean {
  if (!useRegex)
    return line => line.includes(query)

  try {
    const pattern = new RegExp(query)
    return line => pattern.test(line)
  }
  catch {
    // NOTICE: an invalid regex from a model falls back to literal substring search
    // instead of failing the whole tool call, so one bad pattern never aborts a step.
    return line => line.includes(query)
  }
}

/** Reports whether a line declares `query`, used to rank definitions above references. */
function isDefinitionLine(line: string, query: string): boolean {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b(?:function|class|interface|type|enum|const|let|var)\\s+${escaped}\\b`).test(line)
}

/**
 * Scores a search match so declarations rank above references and generated/test files rank below source.
 *
 * Higher is better. Used only to order results; the returned match shape is unchanged.
 */
function scoreSearchMatch(match: ProjectSearchMatch, query: string, useRegex: boolean): number {
  let score = 0
  if (!useRegex && isDefinitionLine(match.text, query))
    score += 100
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(match.path))
    score -= 50
  if (/(?:^|\/)(?:dist|out|build)\//.test(match.path) || match.path.includes('.min.'))
    score -= 40
  return score
}

/**
 * Searches text files under a project path with optional regex, definition-first ranking, and trimming.
 *
 * Use when:
 * - Worker or reviewer agent needs grep-like context without unrestricted shell access
 *
 * Expects:
 * - Binary files may be skipped when UTF-8 reading fails
 * - `regex` compiles the query as a RegExp; an invalid pattern falls back to literal substring search
 *
 * Returns:
 * - Matching lines ranked (declarations first, generated/test files last), long lines truncated, capped to the limit
 */
export async function searchProjectFiles(params: {
  projectRoot: string
  query: string
  relativePath?: string
  forbiddenPathPatterns?: string[]
  maxMatches?: number
  maxFiles?: number
  regex?: boolean
}): Promise<ProjectSearchMatch[]> {
  const files: string[] = []
  const collected: ProjectSearchMatch[] = []
  const maxMatches = params.maxMatches ?? DEFAULT_SEARCH_LIMIT
  // Collect more than the cap so ranking can promote the best matches before slicing.
  const collectCap = Math.max(maxMatches * 4, 200)
  const matchesLine = createLineMatcher(params.query, params.regex === true)
  await collectSearchFiles({
    projectRoot: params.projectRoot,
    relativePath: params.relativePath ?? '.',
    forbiddenPathPatterns: params.forbiddenPathPatterns ?? [],
    files,
    maxFiles: params.maxFiles ?? 2000,
  })

  for (const file of files) {
    if (collected.length >= collectCap)
      break

    let text = ''
    try {
      text = await readProjectFile({
        projectRoot: params.projectRoot,
        relativePath: file,
        forbiddenPathPatterns: params.forbiddenPathPatterns,
      })
    }
    catch {
      continue
    }

    const lines = text.split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      if (!matchesLine(line))
        continue
      collected.push({
        path: file,
        line: index + 1,
        text: trimSearchLine(line),
      })
      if (collected.length >= collectCap)
        break
    }
  }

  // Definition-first, source-before-test ranking; ties keep discovery order via the index tiebreak.
  return collected
    .map((match, index) => ({ match, index, score: scoreSearchMatch(match, params.query, params.regex === true) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxMatches)
    .map(entry => entry.match)
}

function truncateOutput(output: string, limit: number): string {
  if (output.length <= limit)
    return output
  return `${output.slice(0, limit)}\n[truncated ${output.length - limit} bytes]`
}

/**
 * Runs a shell command under the project root after AIRI policy checks.
 *
 * Use when:
 * - Worker agent needs package manager, test, formatter, or language tooling commands
 *
 * Expects:
 * - Destructive command tokens are blocked by `settings.shellDenylist`
 *
 * Returns:
 * - Exit code and captured stdout/stderr
 *
 * Call stack:
 *
 * project runner loop
 *   -> {@link runProjectShellCommand}
 *     -> {@link evaluateShellCommandPolicy}
 *       -> node:child_process spawn
 */
export async function runProjectShellCommand(params: {
  projectRoot: string
  command: string
  settings: Pick<ProjectAgentSettings, 'shellAllowlist' | 'shellDenylist' | 'timeoutMs'>
  outputLimit?: number
}): Promise<ProjectShellResult> {
  const policy = evaluateShellCommandPolicy(params.command, params.settings)
  if (!policy.allowed)
    throw new Error(policy.reason ?? 'Command is not allowed.')

  const cwd = resolveProjectToolPath(params.projectRoot, '.').absolutePath
  const outputLimit = params.outputLimit ?? DEFAULT_OUTPUT_LIMIT

  return await new Promise<ProjectShellResult>((resolvePromise, reject) => {
    // Process execution is intentionally scoped to cwd and timeout because worker LLMs can call this tool.
    const child = spawn(params.command, {
      cwd,
      shell: true,
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, params.settings.timeoutMs)

    child.stdout?.on('data', (chunk) => {
      stdout = truncateOutput(stdout + chunk.toString('utf-8'), outputLimit)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = truncateOutput(stderr + chunk.toString('utf-8'), outputLimit)
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timeout)
      resolvePromise({
        exitCode,
        stdout,
        stderr,
        timedOut,
      })
    })
  })
}

/**
 * Reads git dirty files for a project.
 *
 * Use when:
 * - AIRI must stop and ask the user before worker edits begin on a dirty worktree
 *
 * Expects:
 * - Non-git projects are allowed; git failure returns an empty clean result with stderr
 *
 * Returns:
 * - Dirty flag, porcelain file lines, and stderr if git failed
 */
export async function inspectGitDirtyFiles(projectRoot: string): Promise<{ dirty: boolean, files: string[], stderr?: string }> {
  const result = await runProjectShellCommand({
    projectRoot,
    command: 'git status --porcelain',
    settings: {
      shellAllowlist: ['git status'],
      shellDenylist: [],
      timeoutMs: 30000,
    },
  })

  if (result.exitCode !== 0) {
    return {
      dirty: false,
      files: [],
      stderr: result.stderr,
    }
  }

  const files = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  return {
    dirty: files.length > 0,
    files,
  }
}
