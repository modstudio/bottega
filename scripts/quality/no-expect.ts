import ts from 'typescript'
import type { Finding } from './ratchet'

const TEST_NAMES = new Set(['it', 'test'])

function rootCallName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return rootCallName(expression.expression)
  if (ts.isCallExpression(expression)) return rootCallName(expression.expression)
  return undefined
}

function testBody(
  call: ts.CallExpression,
  source: ts.SourceFile,
): ts.FunctionLikeDeclaration | undefined {
  for (let index = call.arguments.length - 1; index >= 0; index--) {
    const argument = call.arguments[index]!
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return argument
    if (!ts.isIdentifier(argument)) continue
    const symbol = source.locals?.get(argument.escapedText)
    for (const declaration of symbol?.declarations ?? []) {
      if (ts.isFunctionDeclaration(declaration) && declaration.body) return declaration
      if (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))
      ) {
        return declaration.initializer
      }
    }
  }
  return undefined
}

function reachesExpect(node: ts.Node, source: ts.SourceFile, seen: Set<ts.Node>): boolean {
  if (seen.has(node)) return false
  seen.add(node)
  let found = false

  function visit(child: ts.Node) {
    if (found) return
    if (ts.isCallExpression(child)) {
      if (ts.isIdentifier(child.expression) && child.expression.text === 'expect') {
        found = true
        return
      }
      if (ts.isIdentifier(child.expression)) {
        const symbol = source.locals?.get(child.expression.escapedText)
        for (const declaration of symbol?.declarations ?? []) {
          if (
            ts.isFunctionDeclaration(declaration) &&
            declaration.body &&
            reachesExpect(declaration.body, source, seen)
          ) {
            found = true
            return
          }
          if (
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) ||
              ts.isFunctionExpression(declaration.initializer)) &&
            reachesExpect(declaration.initializer, source, seen)
          ) {
            found = true
            return
          }
        }
      }
    }
    ts.forEachChild(child, visit)
  }

  ts.forEachChild(node, visit)
  return found
}

function testName(call: ts.CallExpression) {
  const first = call.arguments[0]
  if (first && ts.isStringLiteralLike(first)) return first.text
  if (first && ts.isNoSubstitutionTemplateLiteral(first)) return first.text
  return '<dynamic name>'
}

export function noExpectFindings(file: string, content: string): Finding[] {
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  // Bind same-file helper declarations so a test which reaches expect() through a local
  // helper is not mistaken for a vacuous body.
  ts.bindSourceFile(source, { target: ts.ScriptTarget.Latest })
  const findings: Finding[] = []

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && TEST_NAMES.has(rootCallName(node.expression) ?? '')) {
      const body = testBody(node, source)
      if (body && !reachesExpect(body, source, new Set())) {
        const location = source.getLineAndCharacterOfPosition(node.getStart(source))
        findings.push({
          file,
          line: location.line + 1,
          rule: 'test-reaches-expect',
          message: `test ${JSON.stringify(testName(node))} reaches 0 expect() calls`,
        })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return findings
}
