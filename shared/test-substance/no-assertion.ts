import { isAbsolute } from 'node:path'
import type { Rule } from 'eslint'
import ts from 'typescript'
import {
  type InMemoryTypeScriptFile,
  inMemoryTypeScriptFile,
  readRelativeModule,
} from './relative-module'

const TEST_NAMES = new Set(['it', 'test'])
type ImportedFunction = {
  declaration?: ts.FunctionLikeDeclaration
  parsed?: InMemoryTypeScriptFile
  unresolved: boolean
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

function symbolAt(name: ts.Identifier, parsed: InMemoryTypeScriptFile) {
  return parsed.checker.getSymbolAtLocation(name)
}

function functionArgument(
  call: ts.CallExpression,
  parsed: InMemoryTypeScriptFile,
): ts.FunctionLikeDeclaration | undefined {
  for (let index = call.arguments.length - 1; index >= 0; index -= 1) {
    const argument = call.arguments[index]!
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return argument
    if (!ts.isIdentifier(argument)) continue
    for (const declaration of symbolAt(argument, parsed)?.declarations ?? []) {
      const callable = callableDeclaration(declaration)
      if (callable) return callable
    }
  }
  return undefined
}

function relativeImport(name: ts.Identifier, parsed: InMemoryTypeScriptFile) {
  const declaration = symbolAt(name, parsed)?.declarations?.find(ts.isImportSpecifier)
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

function isRelativeImport(name: ts.Identifier, parsed: InMemoryTypeScriptFile) {
  return Boolean(relativeImport(name, parsed))
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

function locallyReexportedFunction(
  statement: ts.Statement,
  parsed: InMemoryTypeScriptFile,
  name: string,
) {
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
  const localIdentifier = exportedName.propertyName ?? exportedName.name
  let symbol = symbolAt(localIdentifier, parsed)
  if (symbol && symbol.flags & ts.SymbolFlags.Alias)
    symbol = parsed.checker.getAliasedSymbol(symbol)
  return symbol?.declarations?.map(callableDeclaration).find(Boolean)
}

function exportedFunction(parsed: InMemoryTypeScriptFile, name: string) {
  for (const statement of parsed.source.statements) {
    const callable =
      directlyExportedFunction(statement, name) ??
      locallyReexportedFunction(statement, parsed, name)
    if (callable) return callable
  }
  return undefined
}

function importedFunction(
  name: ts.Identifier,
  parsed: InMemoryTypeScriptFile,
  testFile: string,
  cache: Map<string, ImportedFunction>,
): ImportedFunction | undefined {
  const imported = relativeImport(name, parsed)
  if (!imported) return undefined
  const key = `${imported.specifier}\0${imported.importedName}`
  const cached = cache.get(key)
  if (cached) return cached
  const module = readRelativeModule(testFile, imported.specifier)
  if (!module) {
    const result = { unresolved: true }
    cache.set(key, result)
    return result
  }
  try {
    const importedParsed = module.parsed
    const declaration = exportedFunction(importedParsed, imported.importedName)
    const result = declaration
      ? { declaration, parsed: importedParsed, unresolved: false }
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
  parsed: InMemoryTypeScriptFile,
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
    const local = symbolAt(child.expression, parsed)
      ?.declarations?.map(callableDeclaration)
      .find(Boolean)
    if (local && reachesAssertion(local, parsed, testFile, seen, imports)) return true
    if (parsed.source.fileName !== testFile && isRelativeImport(child.expression, parsed)) {
      return true
    }
    const imported = importedFunction(child.expression, parsed, testFile, imports)
    if (imported?.unresolved) return true
    return Boolean(
      imported?.declaration &&
        imported.parsed &&
        reachesAssertion(imported.declaration, imported.parsed, testFile, seen, imports),
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
          const parsed = inMemoryTypeScriptFile(testFile, context.sourceCode.text)
          const { source } = parsed
          function visit(node: ts.Node) {
            if (ts.isCallExpression(node) && TEST_NAMES.has(rootCallName(node.expression) ?? '')) {
              const body = functionArgument(node, parsed)
              if (body && !reachesAssertion(body, parsed, testFile, new Set(), new Map())) {
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
