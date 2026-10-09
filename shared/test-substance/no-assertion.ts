import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Rule } from 'eslint'
import ts from 'typescript'

const TEST_NAMES = new Set(['it', 'test'])
const MAX_IMPORTED_FILE_BYTES = 1024 * 1024
const IMPORT_EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

type BoundNode = ts.Node & { locals?: Map<ts.__String, ts.Symbol> }
type BoundSourceFile = ts.SourceFile & { locals?: Map<ts.__String, ts.Symbol> }
type TypeScriptWithBinder = typeof ts & {
  bindSourceFile(source: ts.SourceFile, options: ts.CompilerOptions): void
}
type ImportedFunction = {
  declaration?: ts.FunctionLikeDeclaration
  source?: BoundSourceFile
  unresolved: boolean
}

function hasParseErrors(source: ts.SourceFile) {
  return Boolean(
    (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics
      ?.length,
  )
}

function bind(file: string, content: string): BoundSourceFile {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  ;(ts as TypeScriptWithBinder).bindSourceFile(source, { target: ts.ScriptTarget.Latest })
  return source
}

function rootCallName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return rootCallName(expression.expression)
  if (ts.isCallExpression(expression)) return rootCallName(expression.expression)
  return undefined
}

function finalCallName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text
  }
  return undefined
}

function callableDeclaration(declaration: ts.Declaration): ts.FunctionLikeDeclaration | undefined {
  if (ts.isFunctionDeclaration(declaration) && declaration.body) return declaration
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    (ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer))
  ) {
    return declaration.initializer
  }
  return undefined
}

function symbolInScope(name: ts.Identifier, from: ts.Node, source: BoundSourceFile) {
  let current: ts.Node | undefined = from
  while (current) {
    const symbol = (current as BoundNode).locals?.get(name.escapedText)
    if (symbol) return symbol
    current = current.parent
  }
  return source.locals?.get(name.escapedText)
}

function functionArgument(
  call: ts.CallExpression,
  source: BoundSourceFile,
): ts.FunctionLikeDeclaration | undefined {
  for (let index = call.arguments.length - 1; index >= 0; index -= 1) {
    const argument = call.arguments[index]!
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return argument
    if (!ts.isIdentifier(argument)) continue
    for (const declaration of symbolInScope(argument, call, source)?.declarations ?? []) {
      const callable = callableDeclaration(declaration)
      if (callable) return callable
    }
  }
  return undefined
}

function relativeImport(name: ts.Identifier, from: ts.Node, source: BoundSourceFile) {
  const declaration = symbolInScope(name, from, source)?.declarations?.find(ts.isImportSpecifier)
  if (!declaration) return undefined
  const importDeclaration = declaration.parent.parent.parent
  if (!ts.isImportDeclaration(importDeclaration)) return undefined
  const specifier = importDeclaration.moduleSpecifier
  if (!ts.isStringLiteralLike(specifier) || !specifier.text.startsWith('.')) return undefined
  return {
    importedName: declaration.propertyName?.text ?? declaration.name.text,
    specifier: specifier.text,
  }
}

function isRelativeImport(name: ts.Identifier, from: ts.Node, source: BoundSourceFile) {
  return Boolean(relativeImport(name, from, source))
}

function resolveImport(testFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(testFile), specifier)
  const candidates = [
    ...IMPORT_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...IMPORT_EXTENSIONS.slice(1).map((extension) => join(base, `index${extension}`)),
  ]
  return candidates.find((candidate) => {
    try {
      return existsSync(candidate) && statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

function hasExportModifier(statement: ts.Statement) {
  return (
    ts.canHaveModifiers(statement) &&
    ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  )
}

function directlyExportedFunction(statement: ts.Statement, name: string) {
  if (!hasExportModifier(statement)) return undefined
  if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
    return statement.body ? statement : undefined
  }
  if (!ts.isVariableStatement(statement)) return undefined
  const declaration = statement.declarationList.declarations.find(
    (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
  )
  return declaration && callableDeclaration(declaration)
}

function locallyReexportedFunction(statement: ts.Statement, source: BoundSourceFile, name: string) {
  if (
    !ts.isExportDeclaration(statement) ||
    statement.moduleSpecifier ||
    !statement.exportClause ||
    !ts.isNamedExports(statement.exportClause)
  ) {
    return undefined
  }
  const exportedName = statement.exportClause.elements.find((element) => element.name.text === name)
  if (!exportedName) return undefined
  const localName = exportedName.propertyName?.text ?? exportedName.name.text
  const symbol = source.locals?.get(ts.escapeLeadingUnderscores(localName))
  return symbol?.declarations?.map(callableDeclaration).find(Boolean)
}

function exportedFunction(source: BoundSourceFile, name: string) {
  for (const statement of source.statements) {
    const callable =
      directlyExportedFunction(statement, name) ??
      locallyReexportedFunction(statement, source, name)
    if (callable) return callable
  }
  return undefined
}

function importedFunction(
  name: ts.Identifier,
  from: ts.Node,
  source: BoundSourceFile,
  testFile: string,
  cache: Map<string, ImportedFunction>,
): ImportedFunction | undefined {
  const imported = relativeImport(name, from, source)
  if (!imported) return undefined
  const key = `${imported.specifier}\0${imported.importedName}`
  const cached = cache.get(key)
  if (cached) return cached
  const file = resolveImport(testFile, imported.specifier)
  if (!file) {
    const result = { unresolved: true }
    cache.set(key, result)
    return result
  }
  try {
    const metadata = statSync(file)
    if (metadata.size > MAX_IMPORTED_FILE_BYTES) throw new Error('imported file exceeds size limit')
    const importedSource = bind(file, readFileSync(file, 'utf8'))
    if (hasParseErrors(importedSource)) throw new Error('imported file could not be parsed')
    const declaration = exportedFunction(importedSource, imported.importedName)
    const result = declaration
      ? { declaration, source: importedSource, unresolved: false }
      : { unresolved: true }
    cache.set(key, result)
    return result
  } catch {
    const result = { unresolved: true }
    cache.set(key, result)
    return result
  }
}

function reachesAssertion(
  node: ts.Node,
  source: BoundSourceFile,
  testFile: string,
  seen: Set<ts.Node>,
  imports: Map<string, ImportedFunction>,
): boolean {
  if (seen.has(node)) return false
  seen.add(node)
  let found = false

  function callReachesAssertion(child: ts.CallExpression) {
    const callName = finalCallName(child.expression)
    if (callName && /^(?:expect|assert)/.test(callName)) return true
    if (!ts.isIdentifier(child.expression)) return false
    const local = symbolInScope(child.expression, child, source)
      ?.declarations?.map(callableDeclaration)
      .find(Boolean)
    if (local && reachesAssertion(local, source, testFile, seen, imports)) return true
    if (source.fileName !== testFile && isRelativeImport(child.expression, child, source)) {
      return true
    }
    const imported = importedFunction(child.expression, child, source, testFile, imports)
    if (imported?.unresolved) return true
    return Boolean(
      imported?.declaration &&
        imported.source &&
        reachesAssertion(imported.declaration, imported.source, testFile, seen, imports),
    )
  }

  function visit(child: ts.Node) {
    if (found) return
    if (ts.isCallExpression(child) && callReachesAssertion(child)) found = true
    ts.forEachChild(child, visit)
  }

  ts.forEachChild(node, visit)
  return found
}

export function noAssertionRule(testFile: string): Rule.RuleModule {
  if (!isAbsolute(testFile)) throw new Error('test-substance requires an absolute test file path')
  return {
    meta: {
      type: 'problem',
      schema: [],
      messages: { noAssertion: 'This test reaches no assertion.' },
    },
    create(context) {
      return {
        Program() {
          const source = bind(testFile, context.sourceCode.text)
          function visit(node: ts.Node) {
            if (ts.isCallExpression(node) && TEST_NAMES.has(rootCallName(node.expression) ?? '')) {
              const body = functionArgument(node, source)
              if (body && !reachesAssertion(body, source, testFile, new Set(), new Map())) {
                const start = source.getLineAndCharacterOfPosition(node.getStart(source))
                const end = source.getLineAndCharacterOfPosition(node.getEnd())
                context.report({
                  loc: {
                    start: { line: start.line + 1, column: start.character },
                    end: { line: end.line + 1, column: end.character },
                  },
                  messageId: 'noAssertion',
                })
              }
            }
            ts.forEachChild(node, visit)
          }
          visit(source)
        },
      }
    },
  }
}
