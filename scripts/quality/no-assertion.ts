import type { Rule } from 'eslint'
import ts from 'typescript'

const TEST_NAMES = new Set(['it', 'test'])

function rootCallName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return rootCallName(expression.expression)
  if (ts.isCallExpression(expression)) return rootCallName(expression.expression)
  return undefined
}

function functionArgument(
  call: ts.CallExpression,
  source: ts.SourceFile,
): ts.FunctionLikeDeclaration | undefined {
  for (let index = call.arguments.length - 1; index >= 0; index -= 1) {
    const argument = call.arguments[index]!
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return argument
    if (!ts.isIdentifier(argument)) continue
    const symbol = source.locals?.get(argument.escapedText)
    for (const declaration of symbol?.declarations ?? []) {
      const callable = callableDeclaration(declaration)
      if (callable) return callable
    }
  }
  return undefined
}

function isImportedAssertion(name: ts.Identifier, source: ts.SourceFile) {
  if (!/^(?:expect|assert)/.test(name.text)) return false
  const symbol = source.locals?.get(name.escapedText)
  return symbol?.declarations?.some(
    (declaration) =>
      ts.isImportSpecifier(declaration) ||
      ts.isImportClause(declaration) ||
      ts.isNamespaceImport(declaration) ||
      ts.isImportEqualsDeclaration(declaration),
  )
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

function localFunctions(name: ts.Identifier, source: ts.SourceFile) {
  return (source.locals?.get(name.escapedText)?.declarations ?? [])
    .map(callableDeclaration)
    .filter((declaration): declaration is ts.FunctionLikeDeclaration => Boolean(declaration))
}

function reachesAssertion(node: ts.Node, source: ts.SourceFile, seen: Set<ts.Node>): boolean {
  if (seen.has(node)) return false
  seen.add(node)
  let found = false

  function visit(child: ts.Node) {
    if (found) return
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
      const name = child.expression
      const directAssertion = name.text === 'expect' || name.text.startsWith('assert')
      const localAssertion = localFunctions(name, source).some((declaration) =>
        reachesAssertion(declaration, source, seen),
      )
      if (directAssertion || localAssertion || isImportedAssertion(name, source)) {
        found = true
        return
      }
    }
    ts.forEachChild(child, visit)
  }

  ts.forEachChild(node, visit)
  return found
}

export const noAssertionRule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      noAssertion: 'This test reaches no assertion.',
    },
  },
  create(context) {
    return {
      Program() {
        const text = context.sourceCode.text
        const source = ts.createSourceFile(
          context.filename,
          text,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX,
        )
        // Bind same-file declarations so calls through local helpers can be followed.
        ts.bindSourceFile(source, { target: ts.ScriptTarget.Latest })

        function visit(node: ts.Node) {
          if (ts.isCallExpression(node) && TEST_NAMES.has(rootCallName(node.expression) ?? '')) {
            const body = functionArgument(node, source)
            if (body && !reachesAssertion(body, source, new Set())) {
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
