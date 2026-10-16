#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const PREVIEW = join(ROOT, 'hub/ui/.storybook/preview.tsx')
const STORIES = join(ROOT, 'hub/ui/src')

function propertyName(node: ts.PropertyName | undefined) {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : undefined
}

function property(object: ts.ObjectLiteralExpression, name: string) {
  return object.properties.find(
    (item): item is ts.PropertyAssignment =>
      ts.isPropertyAssignment(item) && propertyName(item.name) === name,
  )
}

function a11yConfiguration(object: ts.ObjectLiteralExpression) {
  const parameters = property(object, 'parameters')?.initializer
  if (!parameters || !ts.isObjectLiteralExpression(parameters)) return undefined
  const a11y = property(parameters, 'a11y')?.initializer
  if (!a11y || !ts.isObjectLiteralExpression(a11y)) return undefined
  return a11y
}

function nestedTestValue(object: ts.ObjectLiteralExpression) {
  const a11y = a11yConfiguration(object)
  const test = a11y && property(a11y, 'test')?.initializer
  return test && ts.isStringLiteral(test) ? test : undefined
}

function unwrapObject(expression: ts.Expression): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(expression)) return expression
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  )
    return unwrapObject(expression.expression)
}

export function analyzePreview(sourceText: string) {
  const source = ts.createSourceFile(
    'preview.tsx',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const declarations = new Map<string, ts.Expression>()
  for (const statement of source.statements)
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.initializer)
          declarations.set(declaration.name.text, declaration.initializer)
  const exported = source.statements.find(
    (statement): statement is ts.ExportAssignment => ts.isExportAssignment(statement),
  )
  const expression = exported?.expression
  const preview = expression
    ? unwrapObject(
        ts.isIdentifier(expression) ? (declarations.get(expression.text) ?? expression) : expression,
      )
    : undefined
  if (preview && nestedTestValue(preview)?.text === 'error') return []
  return ["hub/ui/.storybook/preview.tsx: global parameters.a11y.test must be 'error'"]
}

export function analyzeStoryTodos(sourceText: string, path: string) {
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const violations: string[] = []
  let count = 0
  const lines = sourceText.split('\n')
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const a11y = a11yConfiguration(node)
      const test = a11y && property(a11y, 'test')?.initializer
      const disable = a11y && property(a11y, 'disable')?.initializer
      const exception =
        (test && (!ts.isStringLiteral(test) || test.text !== 'error') ? test : undefined) ??
        (disable?.kind === ts.SyntaxKind.TrueKeyword ? disable : undefined)
      if (exception) {
        count += 1
        const line = source.getLineAndCharacterOfPosition(exception.getStart(source)).line
        const hasReason = [lines[line], lines[line - 1]].some((value) =>
          /\/\/\s*a11y todo:\s*\S.+$/i.test(value ?? ''),
        )
        if (!hasReason)
          violations.push(
            `${path}:${line + 1}: a11y exception requires an "a11y todo: reason" comment on this or the previous line`,
          )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { count, violations }
}

function checkStorybook() {
  const violations = analyzePreview(readFileSync(PREVIEW, 'utf8'))
  let todoCount = 0
  for (const relativePath of new Glob('**/*.stories.tsx').scanSync({ cwd: STORIES })) {
    const analysis = analyzeStoryTodos(
      readFileSync(join(STORIES, relativePath), 'utf8'),
      `hub/ui/src/${relativePath}`,
    )
    todoCount += analysis.count
    violations.push(...analysis.violations)
  }
  return { violations, todoCount }
}

if (import.meta.main) {
  const result = checkStorybook()
  if (result.violations.length) {
    for (const violation of result.violations) console.error(violation)
    process.exit(1)
  }
  console.log(`check-storybook: ok (${result.todoCount} a11y todo stories)`)
}
