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

function nestedTestValue(object: ts.ObjectLiteralExpression) {
  const parameters = property(object, 'parameters')?.initializer
  if (!parameters || !ts.isObjectLiteralExpression(parameters)) return undefined
  const a11y = property(parameters, 'a11y')?.initializer
  if (!a11y || !ts.isObjectLiteralExpression(a11y)) return undefined
  const test = property(a11y, 'test')?.initializer
  return test && ts.isStringLiteral(test) ? test : undefined
}

export function analyzePreview(sourceText: string) {
  const source = ts.createSourceFile(
    'preview.tsx',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer)) {
        const test = nestedTestValue(declaration.initializer)
        if (test?.text === 'error') return []
      }
    }
  }
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
      const test = nestedTestValue(node)
      if (test?.text === 'todo') {
        count += 1
        const line = source.getLineAndCharacterOfPosition(test.getStart(source)).line
        const hasReason = [lines[line], lines[line - 1]].some((value) =>
          /\/\/\s*a11y todo:\s*\S.+$/i.test(value ?? ''),
        )
        if (!hasReason)
          violations.push(
            `${path}:${line + 1}: a11y 'todo' requires an "a11y todo: reason" comment on this or the previous line`,
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
