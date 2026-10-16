#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const UI_SOURCE = join(ROOT, 'hub/ui/src')
const GRIT_PATH = join(ROOT, 'hub/web/lint/layout-only-classname.grit')
const violations: string[] = []
const variantSource = readFileSync(join(UI_SOURCE, 'text/variant.ts'), 'utf8')

const namespaces = {
  color: 'color',
  shadow: 'shadow',
  radius: 'radius',
  font: 'font',
  text: 'text',
  ease: 'ease',
  height: 'spacing',
  width: 'spacing',
} as const

const css = readFileSync(join(UI_SOURCE, 'styles/theme.css'), 'utf8')
const actualKeys = Object.fromEntries(
  Object.values(namespaces).map((namespace) => [namespace, new Set<string>()]),
) as Record<(typeof namespaces)[keyof typeof namespaces], Set<string>>
for (const match of css.matchAll(
  /--(color|shadow|radius|font|text|ease|height|width)-([^:\s]+)\s*:/g,
)) {
  const [, cssNamespace, key] = match
  if (!cssNamespace || !key || key === '*' || key.includes('--')) continue
  actualKeys[namespaces[cssNamespace as keyof typeof namespaces]].add(key)
}
for (const namespace of Object.values(namespaces)) {
  const match = variantSource.match(new RegExp(`\\b${namespace}: \\[(.*?)\\]`, 's'))
  const declared = new Set<string>(
    [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((entry) => entry[1]!),
  )
  const actual = actualKeys[namespace]
  for (const key of actual) {
    if (!declared.has(key))
      violations.push(`hub/ui/src/text/variant.ts: missing ${namespace} theme key ${key}`)
  }
  for (const key of declared) {
    if (!actual.has(key))
      violations.push(`hub/ui/src/text/variant.ts: stale ${namespace} theme key ${key}`)
  }
}

const classNameComponents = new Set<string>()
for (const relativePath of new Glob('**/*.tsx').scanSync({ cwd: UI_SOURCE })) {
  if (/\.(?:test|spec)\.tsx$/.test(relativePath)) continue
  const path = join(UI_SOURCE, relativePath)
  const sourceText = readFileSync(path, 'utf8')
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  let hasClassName = false
  const stem = basename(path, '.tsx')
  const stylesPath = join(dirname(path), `${stem}.styles.ts`)
  const siblingImport = `./${stem}.styles.ts`
  const styleIdentifiers = new Set<string>()
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.moduleSpecifier.getText(source) !== `'${siblingImport}'`
    )
      continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) styleIdentifiers.add(element.name.text)
    }
  }

  const rootIdentifier = (expression: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expression)) return expression.text
    if (ts.isCallExpression(expression)) return rootIdentifier(expression.expression)
    if (ts.isPropertyAccessExpression(expression)) return rootIdentifier(expression.expression)
    return undefined
  }
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'className') {
      hasClassName = true
      const expression = ts.isJsxExpression(node.initializer)
        ? node.initializer.expression
        : undefined
      const identifier =
        expression && ts.isCallExpression(expression) ? rootIdentifier(expression) : undefined
      if (!identifier || !styleIdentifiers.has(identifier)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
        violations.push(
          `${relative(ROOT, path)}:${line}: className must call a style imported from ${siblingImport}`,
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (hasClassName && !existsSync(stylesPath)) {
    violations.push(`${relative(ROOT, path)}: className markup requires sibling ${stem}.styles.ts`)
  }

  for (const statement of source.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.name) continue
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
    if (!exported) continue
    let acceptsClassName = false
    const findClassName = (node: ts.Node) => {
      if (ts.isBindingElement(node) && node.name.getText(source) === 'className')
        acceptsClassName = true
      ts.forEachChild(node, findClassName)
    }
    for (const parameter of statement.parameters) findClassName(parameter)
    if (acceptsClassName) classNameComponents.add(statement.name.text)
  }
}

const grit = readFileSync(GRIT_PATH, 'utf8')
const names = [...classNameComponents].sort().join('|')
const expectedLine = `  $element <: r"(?:${names})",`
const actualLine = grit.split('\n').find((line) => line.includes('$element <: r"'))
if (actualLine !== expectedLine) {
  violations.push(
    `hub/web/lint/layout-only-classname.grit: component list is stale; expected ${expectedLine.trim()}`,
  )
}

if (violations.length) {
  for (const violation of violations) console.error(violation)
  process.exit(1)
}
console.log(
  `check-hub-ui-styles: ok (${Object.values(actualKeys).reduce((sum, keys) => sum + keys.size, 0)} theme keys; ${classNameComponents.size} className components)`,
)
