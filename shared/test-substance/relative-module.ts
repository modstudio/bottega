import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'

const IMPORT_EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const MAX_IMPORTED_FILE_BYTES = 1024 * 1024

export type InMemoryTypeScriptFile = {
  checker: ts.TypeChecker
  hasSyntacticErrors: boolean
  source: ts.SourceFile
}

export function inMemoryTypeScriptFile(file: string, content: string): InMemoryTypeScriptFile {
  const options: ts.CompilerOptions = {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  }
  const source = ts.createSourceFile(file, content, options.target!, true, ts.ScriptKind.TSX)
  const host: ts.CompilerHost = {
    fileExists: (candidate) => candidate === file,
    getCanonicalFileName: (candidate) => candidate,
    getCurrentDirectory: () => dirname(file),
    getDefaultLibFileName: () => '',
    getNewLine: () => '\n',
    getSourceFile: (candidate) => (candidate === file ? source : undefined),
    readFile: (candidate) => (candidate === file ? content : undefined),
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
  }
  const program = ts.createProgram({ host, options, rootNames: [file] })
  return {
    checker: program.getTypeChecker(),
    hasSyntacticErrors: program.getSyntacticDiagnostics(source).length > 0,
    source,
  }
}

export function readRelativeModule(importingFile: string, specifier: string) {
  if (!specifier.startsWith('.')) return undefined
  const base = resolve(dirname(importingFile), specifier)
  const candidates = [
    ...IMPORT_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...IMPORT_EXTENSIONS.slice(1).map((extension) => join(base, `index${extension}`)),
  ]
  for (const file of candidates) {
    let metadata: ReturnType<typeof statSync>
    try {
      metadata = statSync(file)
    } catch {
      continue
    }
    if (!metadata.isFile()) continue
    try {
      if (metadata.size > MAX_IMPORTED_FILE_BYTES) return undefined
      const content = readFileSync(file, 'utf8')
      const parsed = inMemoryTypeScriptFile(file, content)
      if (parsed.hasSyntacticErrors) return undefined
      return { content, file, parsed }
    } catch {
      return undefined
    }
  }
  return undefined
}
