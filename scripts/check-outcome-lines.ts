import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const SOURCE_ROOTS = ['orchestrator/src', 'hub/src']
const REMEDY = 'finish fallible command output with an outcome line that includes its id'

export type OutcomeLineSource = { path: string; source: string }

function productionTypeScript(path: string): boolean {
  return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)
}

function literalExitCode(node: ts.Expression): boolean {
  return (
    ts.isNumericLiteral(node) ||
    (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand))
  )
}

function setsComputedExitCode(node: ts.Node): boolean {
  if (
    ts.isCallExpression(node) &&
    node.arguments.length > 0 &&
    ((ts.isIdentifier(node.expression) && node.expression.text === 'setExitCode') ||
      (ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'setExitCode'))
  )
    return !literalExitCode(node.arguments[0]!)
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(node.left) &&
    ts.isIdentifier(node.left.expression) &&
    node.left.expression.text === 'process' &&
    node.left.name.text === 'exitCode' &&
    !literalExitCode(node.right)
  )
}

function bareIdPrint(node: ts.Node): ts.CallExpression | null {
  if (!ts.isCallExpression(node)) return null
  const called = node.expression
  const prints =
    (ts.isIdentifier(called) && (called.text === 'log' || called.text === 'print')) ||
    (ts.isPropertyAccessExpression(called) &&
      ts.isIdentifier(called.expression) &&
      called.expression.text === 'console' &&
      called.name.text === 'log')
  if (!prints) return null
  const hasBareId = node.arguments.some(
    (argument) =>
      ts.isCallExpression(argument) &&
      ts.isIdentifier(argument.expression) &&
      argument.expression.text === 'String' &&
      argument.arguments.length === 1 &&
      ts.isPropertyAccessExpression(argument.arguments[0]!) &&
      (argument.arguments[0].name.text === 'id' || argument.arguments[0].name.text === 'number'),
  )
  return hasBareId ? node : null
}

type FunctionWithBody = ts.SignatureDeclaration & { body: ts.ConciseBody }

function functionName(node: FunctionWithBody): string | null {
  if ('name' in node && node.name && ts.isIdentifier(node.name)) return node.name.text
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  return null
}

function functionLikes(file: ts.SourceFile): FunctionWithBody[] {
  const functions: FunctionWithBody[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && 'body' in node && node.body)
      functions.push(node as FunctionWithBody)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return functions
}

function functionBodyNodes(node: FunctionWithBody): ts.Node[] {
  const result: ts.Node[] = []
  const visit = (child: ts.Node): void => {
    if (child !== node && ts.isFunctionLike(child)) return
    result.push(child)
    ts.forEachChild(child, visit)
  }
  ts.forEachChild(node, visit)
  return result
}

/** Find fallible command actions whose plain terminal output is still only an id. */
export function outcomeLineViolations(sources: readonly OutcomeLineSource[]): string[] {
  return sources.flatMap(({ path, source }) => {
    if (!productionTypeScript(path)) return []
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const functions = functionLikes(file)
    const computedExitHelpers = new Set(
      functions.flatMap((fn) => {
        const name = functionName(fn)
        return name && functionBodyNodes(fn).some(setsComputedExitCode) ? [name] : []
      }),
    )
    return functions.flatMap((fn) => {
      const nodes = functionBodyNodes(fn)
      const fallible =
        nodes.some(setsComputedExitCode) ||
        nodes.some(
          (node) =>
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            computedExitHelpers.has(node.expression.text),
        )
      if (!fallible) return []
      return nodes.flatMap((node) => {
        const print = bareIdPrint(node)
        if (!print) return []
        const line = file.getLineAndCharacterOfPosition(print.getStart(file)).line + 1
        return [`${path}:${line}: bare id ends fallible command output; ${REMEDY}`]
      })
    })
  })
}

function sourceFiles(): OutcomeLineSource[] {
  const files: string[] = []
  const collect = (directory: string): void => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) collect(absolute)
      else if (entry.isFile()) files.push(relative(ROOT, absolute))
    }
  }
  for (const root of SOURCE_ROOTS) collect(resolve(ROOT, root))
  return files.sort().map((path) => ({ path, source: readFileSync(resolve(ROOT, path), 'utf8') }))
}

if (import.meta.main) {
  const violations = outcomeLineViolations(sourceFiles())
  if (violations.length) {
    console.error(violations.join('\n'))
    process.exit(1)
  }
  console.log('outcome lines: ok')
}
