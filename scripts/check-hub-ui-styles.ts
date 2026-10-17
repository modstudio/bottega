#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const UI_SOURCE = join(ROOT, 'hub/ui/src')
const VIEWS_SOURCE = join(ROOT, 'hub/views/src')
const VARIANT_PATH = join(UI_SOURCE, 'text/variant.ts')
const GRIT_PATH = join(ROOT, 'hub/web/lint/layout-only-classname.grit')

function propertyName(node: ts.PropertyName | undefined) {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node))
    ? node.text
    : undefined
}
function lineOf(source: ts.SourceFile, node: ts.Node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}
function objectProperty(object: ts.ObjectLiteralExpression, name: string) {
  return object.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && propertyName(property.name) === name,
  )
}

function variantImportNames(source: ts.SourceFile, path: string) {
  const variantImports = new Set<string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    if (
      resolve(dirname(path), statement.moduleSpecifier.text) !== VARIANT_PATH &&
      statement.moduleSpecifier.text !== '@bottega/hub-ui/text/variant'
    )
      continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === 'variant')
        variantImports.add(element.name.text)
    }
  }
  return variantImports
}

function variantCall(
  initializer: ts.Expression | undefined,
  imports: ReadonlySet<string>,
): ts.CallExpression | undefined {
  const direct = (node: ts.Expression): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    imports.has(node.expression.text)
  if (initializer && direct(initializer)) return initializer
  if (
    initializer &&
    ts.isArrowFunction(initializer) &&
    ts.isCallExpression(initializer.body) &&
    direct(initializer.body)
  )
    return initializer.body
}

function inspectSlots(
  configuration: ts.ObjectLiteralExpression,
  source: ts.SourceFile,
  path: string,
) {
  const violations: string[] = []
  const slots = objectProperty(configuration, 'slots')?.initializer
  if (!slots || !ts.isObjectLiteralExpression(slots)) return violations
  for (const slot of slots.properties) {
    const name = propertyName(slot.name)
    if (name && /^slot[0-9]+$/.test(name))
      violations.push(`${path}:${lineOf(source, slot)}: numbered style slot ${name} is forbidden`)
  }
  return violations
}

function inspectVariants(
  configuration: ts.ObjectLiteralExpression,
  source: ts.SourceFile,
  path: string,
) {
  const violations: string[] = []
  const values = new Set<string>()
  const variants = objectProperty(configuration, 'variants')?.initializer
  if (!variants || !ts.isObjectLiteralExpression(variants)) return { violations, values }
  for (const variant of variants.properties) {
    if (!ts.isPropertyAssignment(variant)) continue
    const name = propertyName(variant.name)
    if (name && /^slot[0-9]+$/.test(name))
      violations.push(
        `${path}:${lineOf(source, variant)}: numbered variant key ${name} is forbidden`,
      )
    if (!ts.isObjectLiteralExpression(variant.initializer)) continue
    for (const value of variant.initializer.properties) {
      const valueName = propertyName(value.name)
      if (valueName) values.add(valueName)
    }
  }
  return { violations, values }
}

export function analyzeStyleModule(sourceText: string, path: string) {
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const violations: string[] = []
  const variantValues = new Set<string>()
  const variantImports = variantImportNames(source, path)
  const inspectConfiguration = (call: ts.CallExpression) => {
    const configuration = call.arguments[0]
    if (!configuration || !ts.isObjectLiteralExpression(configuration)) return
    violations.push(...inspectSlots(configuration, source, path))
    const variants = inspectVariants(configuration, source, path)
    violations.push(...variants.violations)
    for (const value of variants.values) variantValues.add(value)
  }
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
      continue
    for (const declaration of statement.declarationList.declarations) {
      const call = variantCall(declaration.initializer, variantImports)
      if (call) inspectConfiguration(call)
      else
        violations.push(
          `${path}:${lineOf(source, declaration)}: exported style ${declaration.name.getText(source)} must be created by the shared variant function`,
        )
    }
  }
  if (!variantImports.size)
    violations.push(`${path}: must import variant from the shared text/variant.ts module`)
  return { violations, variantValues }
}

function rootIdentifier(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isCallExpression(expression) || ts.isPropertyAccessExpression(expression))
    return rootIdentifier(expression.expression)
}
function isLayoutClassName(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === 'className'
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text === 'className'
  if (ts.isArrayLiteralExpression(expression)) return expression.elements.every(isLayoutClassName)
  return false
}

export function analyzeComponentStyleCalls(
  sourceText: string,
  path: string,
  siblingImport: string,
  variantValues: ReadonlySet<string>,
) {
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const violations: string[] = []
  const styleIdentifiers = new Set<string>()
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== siblingImport
    )
      continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements) styleIdentifiers.add(element.name.text)
  }
  const inspectArgument = (argument: ts.Expression) => {
    if (
      ts.isTemplateExpression(argument) ||
      ts.isNoSubstitutionTemplateLiteral(argument) ||
      (ts.isBinaryExpression(argument) &&
        argument.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
      (ts.isStringLiteral(argument) && !variantValues.has(argument.text))
    ) {
      violations.push(
        `${relative(ROOT, path)}:${lineOf(source, argument)}: style calls may not receive literal appearance classes`,
      )
      return
    }
    if (!ts.isObjectLiteralExpression(argument)) return
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property)) continue
      if (propertyName(property.name) === 'class') {
        if (!isLayoutClassName(property.initializer))
          violations.push(
            `${relative(ROOT, path)}:${lineOf(source, property)}: style class may only pass through layout className`,
          )
      } else inspectArgument(property.initializer)
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && styleIdentifiers.has(rootIdentifier(node.expression) ?? ''))
      for (const argument of node.arguments) inspectArgument(argument)
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'className') {
      const expression = ts.isJsxExpression(node.initializer)
        ? node.initializer.expression
        : undefined
      const identifier =
        expression && ts.isCallExpression(expression) ? rootIdentifier(expression) : undefined
      if (!identifier || !styleIdentifiers.has(identifier))
        violations.push(
          `${relative(ROOT, path)}:${lineOf(source, node)}: className must call a style imported from ${siblingImport}`,
        )
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

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

function themeInventory() {
  const violations: string[] = []
  const variantSource = readFileSync(VARIANT_PATH, 'utf8')
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
    for (const key of actual)
      if (!declared.has(key))
        violations.push(`hub/ui/src/text/variant.ts: missing ${namespace} theme key ${key}`)
    for (const key of declared)
      if (!actual.has(key))
        violations.push(`hub/ui/src/text/variant.ts: stale ${namespace} theme key ${key}`)
  }
  return { actualKeys, violations }
}

function styleInventory(sourceRoot = UI_SOURCE) {
  const violations: string[] = []
  const styleAnalyses = new Map<string, ReturnType<typeof analyzeStyleModule>>()
  for (const relativePath of new Glob('**/*.styles.ts').scanSync({ cwd: sourceRoot })) {
    const path = join(sourceRoot, relativePath)
    const analysis = analyzeStyleModule(readFileSync(path, 'utf8'), path)
    styleAnalyses.set(path, analysis)
    violations.push(...analysis.violations.map((violation) => violation.replace(`${ROOT}/`, '')))
  }
  return { styleAnalyses, violations }
}

function exportedFunctionAcceptsClassName(source: ts.SourceFile, statement: ts.Statement) {
  if (!ts.isFunctionDeclaration(statement) || !statement.name) return undefined
  if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
    return undefined
  let acceptsClassName = false
  const visit = (node: ts.Node) => {
    if (ts.isBindingElement(node) && node.name.getText(source) === 'className')
      acceptsClassName = true
    ts.forEachChild(node, visit)
  }
  for (const parameter of statement.parameters) visit(parameter)
  return acceptsClassName ? statement.name.text : undefined
}

function componentStoryViolations(path: string, sourceText: string) {
  const stem = basename(path, '.tsx')
  const storyPath = join(dirname(path), `${stem}.stories.tsx`)
  return analyzeComponentStory(
    sourceText,
    existsSync(storyPath) ? readFileSync(storyPath, 'utf8') : undefined,
    path,
  )
}

const interactiveTags = new Set(['button', 'input', 'select', 'textarea'])
const interactiveRoles = new Set([
  'button',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'option',
  'slider',
])

function interactiveOpening(node: ts.JsxOpeningLikeElement, source: ts.SourceFile) {
  if (interactiveTags.has(node.tagName.getText(source))) return true
  return node.attributes.properties.some((attribute) => {
    if (!ts.isJsxAttribute(attribute)) return false
    const name = attribute.name.getText(source)
    return (
      name === 'onKeyDown' ||
      (name === 'role' &&
        ts.isStringLiteral(attribute.initializer) &&
        interactiveRoles.has(attribute.initializer.text))
    )
  })
}

function componentMarkup(source: ts.SourceFile) {
  let rendersMarkup = false
  let rendersInteractiveElement = false
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node))
      rendersMarkup = true
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      interactiveOpening(node, source)
    )
      rendersInteractiveElement = true
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { rendersMarkup, rendersInteractiveElement }
}

function storySubjectImports(story: ts.SourceFile, stem: string) {
  const subjectImports = new Set<string>()
  for (const statement of story.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== `./${stem}` ||
      statement.importClause?.isTypeOnly
    )
      continue
    const clause = statement.importClause
    if (clause?.name) subjectImports.add(clause.name.text)
    const bindings = clause?.namedBindings
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        if (!element.isTypeOnly) subjectImports.add(element.name.text)
  }
  return subjectImports
}

function containsRenderedSubject(node: ts.Node, identifiers: ReadonlySet<string>) {
  let found = false
  const visit = (child: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) &&
      ts.isIdentifier(child.tagName) &&
      identifiers.has(child.tagName.text)
    )
      found = true
    if (!found) ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function playPositions(node: ts.Node, story: ts.SourceFile) {
  let lastUserEvent = -1
  let lastExpect = -1
  const visit = (child: ts.Node) => {
    if (ts.isCallExpression(child) && rootIdentifier(child.expression) === 'userEvent')
      lastUserEvent = Math.max(lastUserEvent, child.getStart(story))
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === 'expect'
    )
      lastExpect = Math.max(lastExpect, child.getStart(story))
    ts.forEachChild(child, visit)
  }
  visit(node)
  return { lastUserEvent, lastExpect }
}

function analyzeStory(story: ts.SourceFile, subjectImports: ReadonlySet<string>) {
  let metaSubject = false
  let rendersSubject = false
  let hasRender = false
  let storyWithoutRender = false
  let hasPlay = false
  let invalidPlay = false
  const inspectStory = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === 'component' &&
      ts.isIdentifier(node.initializer) &&
      subjectImports.has(node.initializer.text)
    )
      metaSubject = true
    if (
      ts.isPropertyAssignment(node) &&
      propertyName(node.name) === 'render'
    ) {
      hasRender = true
      if (containsRenderedSubject(node.initializer, subjectImports)) rendersSubject = true
    }
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'play') {
      hasPlay = true
      const positions = playPositions(node.initializer, story)
      if (positions.lastUserEvent < 0 || positions.lastExpect < positions.lastUserEvent)
        invalidPlay = true
    }
    ts.forEachChild(node, inspectStory)
  }
  inspectStory(story)
  if (hasRender && containsRenderedSubject(story, subjectImports)) rendersSubject = true
  for (const statement of story.statements) {
    if (!ts.isVariableStatement(statement)) continue
    if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
      continue
    for (const declaration of statement.declarationList.declarations) {
      if (
        declaration.initializer &&
        ts.isObjectLiteralExpression(declaration.initializer) &&
        !declaration.initializer.properties.some(
          (property) =>
            (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) &&
            propertyName(property.name) === 'render',
        )
      )
        storyWithoutRender = true
    }
  }
  return {
    coversSubject: rendersSubject || (metaSubject && storyWithoutRender),
    hasPlay,
    invalidPlay,
  }
}

export function analyzeComponentStory(
  sourceText: string,
  storyText: string | undefined,
  componentPath: string,
) {
  const source = ts.createSourceFile(
    componentPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const markup = componentMarkup(source)
  if (!markup.rendersMarkup) return []
  const stem = basename(componentPath, '.tsx')
  if (storyText === undefined)
    return [
      `${relative(ROOT, componentPath)}: markup component requires sibling ${stem}.stories.tsx`,
    ]
  const story = ts.createSourceFile(
    `${stem}.stories.tsx`,
    storyText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const subjectImports = storySubjectImports(story, stem)
  if (!subjectImports.size)
    return [
      `${relative(ROOT, componentPath)}: sibling ${stem}.stories.tsx must value-import ./${stem}`,
    ]
  const analysis = analyzeStory(story, subjectImports)
  const violations = analysis.coversSubject
    ? []
    : [
        `${relative(ROOT, componentPath)}: sibling ${stem}.stories.tsx must name an imported subject as meta component or render it in a story`,
      ]
  if (analysis.invalidPlay)
    violations.push(
      `${relative(ROOT, componentPath)}: every play function must call expect after its last userEvent call`,
    )
  if (markup.rendersInteractiveElement && !analysis.hasPlay)
    violations.push(
      `${relative(ROOT, componentPath)}: interactive component requires a story with a play function`,
    )
  return violations
}

function componentInventory(
  styleAnalyses: ReadonlyMap<string, ReturnType<typeof analyzeStyleModule>>,
  sourceRoot = UI_SOURCE,
) {
  const violations: string[] = []
  const classNameComponents = new Set<string>()
  for (const relativePath of new Glob('**/*.tsx').scanSync({ cwd: sourceRoot })) {
    if (/\.(?:test|spec)\.tsx$/.test(relativePath)) continue
    const path = join(sourceRoot, relativePath)
    const sourceText = readFileSync(path, 'utf8')
    const source = ts.createSourceFile(
      path,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    )
    const stem = basename(path, '.tsx')
    if (stem.endsWith('.stories')) continue
    const stylesPath = join(dirname(path), `${stem}.styles.ts`)
    const siblingImport = `./${stem}.styles.ts`
    violations.push(...componentStoryViolations(path, sourceText))
    const hasClassName = /\bclassName\s*=/.test(sourceText)
    if (hasClassName && !existsSync(stylesPath))
      violations.push(
        `${relative(ROOT, path)}: className markup requires sibling ${stem}.styles.ts`,
      )
    else if (hasClassName) {
      const analysis = styleAnalyses.get(stylesPath)!
      violations.push(
        ...analyzeComponentStyleCalls(sourceText, path, siblingImport, analysis.variantValues),
      )
    }
    for (const statement of source.statements) {
      const component = exportedFunctionAcceptsClassName(source, statement)
      if (component) classNameComponents.add(component)
    }
  }
  return { classNameComponents, violations }
}

export function analyzeHubViewDomainTerms(sourceText: string, path: string) {
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const violations: string[] = []
  const visit = (node: ts.Node) => {
    const text =
      ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? node.text
        : undefined
    if (text && /articles?/i.test(text)) {
      violations.push(
        `${relative(ROOT, path)}:${lineOf(source, node)}: hub-views production source may not name the docs domain`,
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

function viewDomainTermInventory() {
  const violations: string[] = []
  for (const relativePath of new Glob('**/*.{ts,tsx}').scanSync({ cwd: VIEWS_SOURCE })) {
    if (/\.(?:stories|test|spec)\.[cm]?tsx?$/.test(relativePath)) continue
    const path = join(VIEWS_SOURCE, relativePath)
    violations.push(...analyzeHubViewDomainTerms(readFileSync(path, 'utf8'), path))
  }
  return violations
}

function checkHubUiStyles() {
  const theme = themeInventory()
  const styles = styleInventory()
  const components = componentInventory(styles.styleAnalyses)
  const viewStyles = styleInventory(VIEWS_SOURCE)
  const viewComponents = componentInventory(viewStyles.styleAnalyses, VIEWS_SOURCE)
  const violations = [
    ...theme.violations,
    ...styles.violations,
    ...components.violations,
    ...viewStyles.violations,
    ...viewComponents.violations,
    ...viewDomainTermInventory(),
  ]
  const classNameComponents = components.classNameComponents
  const names = [...classNameComponents].sort().join('|')
  const expectedLine = `  $element <: r"(?:${names})",`
  const actualLine = readFileSync(GRIT_PATH, 'utf8')
    .split('\n')
    .find((line) => line.includes('$element <: r"'))
  if (actualLine !== expectedLine)
    violations.push(
      `hub/web/lint/layout-only-classname.grit: component list is stale; expected ${expectedLine.trim()}`,
    )
  return {
    violations,
    message: `check-hub-ui-styles: ok (${Object.values(theme.actualKeys).reduce((sum, keys) => sum + keys.size, 0)} theme keys; ${classNameComponents.size} className components)`,
  }
}

if (import.meta.main) {
  const result = checkHubUiStyles()
  if (result.violations.length) {
    for (const violation of result.violations) console.error(violation)
    process.exit(1)
  }
  console.log(result.message)
}
