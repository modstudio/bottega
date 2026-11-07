import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Glob } from 'bun'
import * as ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const BASELINE_PATH = resolve(ROOT, 'scripts/quality/refusal-remedy.json')
const RENDERER = 'shared/refusal.ts'

export type RefusalRemedyBaseline = {
  rawLiterals: Record<string, number>
  missingRemedies: Record<string, number>
  commandCases: Record<string, { test?: string; exemption?: string }>
}

export type RefusalRemedyFindings = {
  rawLiterals: { file: string; line: number }[]
  missingRemedies: { file: string; line: number }[]
  commandRemedies: { id: string; file: string; line: number }[]
}

function productionPath(path: string): boolean {
  return (
    path.endsWith('.ts') &&
    !path.endsWith('.test.ts') &&
    !path.endsWith('.d.ts') &&
    !path.includes('/test/')
  )
}

function sourceFiles(): string[] {
  return [
    'orchestrator/src/**/*.ts',
    'shared/**/*.ts',
    'hub/src/**/*.ts',
    'cli/**/*.ts',
    'scripts/**/*.ts',
  ]
    .flatMap((pattern) => [...new Glob(pattern).scanSync({ cwd: ROOT, onlyFiles: true })])
    .filter(productionPath)
    .filter((path) => path !== 'scripts/check-refusal-remedy.ts')
    .sort()
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

function propertyNamed(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | null {
  const property = object.properties.find(
    (candidate) => ts.isPropertyAssignment(candidate) && candidate.name.getText() === name,
  )
  return property && ts.isPropertyAssignment(property) ? property : null
}

function commandRemedy(argument: ts.Expression | undefined): boolean {
  if (!argument || !ts.isObjectLiteralExpression(argument)) return false
  const kind = propertyNamed(argument, 'kind')?.initializer
  return Boolean(kind && ts.isStringLiteral(kind) && kind.text === 'command')
}

function refusalImportBindings(
  file: string,
  statement: ts.Statement,
): ts.NamedImportBindings | null {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
    return null
  const clause = statement.importClause
  if (
    !clause?.namedBindings ||
    clause.isTypeOnly ||
    normalize(join(dirname(file), statement.moduleSpecifier.text)) !== RENDERER
  )
    return null
  return clause.namedBindings
}

function refusalBindings(
  file: string,
  source: ts.SourceFile,
): {
  named: Set<string>
  namespaces: Set<string>
} {
  const named = new Set<string>()
  const namespaces = new Set<string>()
  for (const statement of source.statements) {
    const bindings = refusalImportBindings(file, statement)
    if (!bindings) continue
    if (ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly && (element.propertyName ?? element.name).text === 'refusal')
          named.add(element.name.text)
      }
    } else if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text)
    }
  }
  return { named, namespaces }
}

function isRefusalCall(
  expression: ts.LeftHandSideExpression,
  bindings: ReturnType<typeof refusalBindings>,
): boolean {
  if (ts.isIdentifier(expression)) return bindings.named.has(expression.text)
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    bindings.namespaces.has(expression.expression.text) &&
    expression.name.text === 'refusal'
  )
}

function enclosingName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name)
      return current.name.getText()
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text
    current = current.parent
  }
  return '<top-level>'
}

export function refusalRemedyFindings(
  files: Readonly<Record<string, string>>,
): RefusalRemedyFindings {
  const findings: RefusalRemedyFindings = {
    rawLiterals: [],
    missingRemedies: [],
    commandRemedies: [],
  }
  for (const [file, text] of Object.entries(files)) {
    if (!productionPath(file)) continue
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const bindings = refusalBindings(file, source)
    const visit = (node: ts.Node): void => {
      if (
        file !== RENDERER &&
        (ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)) &&
        node.text.includes('cleared by:')
      ) {
        findings.rawLiterals.push({ file, line: lineOf(source, node) })
      }
      if (ts.isCallExpression(node) && isRefusalCall(node.expression, bindings)) {
        if (!node.arguments[1]) findings.missingRemedies.push({ file, line: lineOf(source, node) })
        if (commandRemedy(node.arguments[1])) {
          findings.commandRemedies.push({
            id: `${file}#${enclosingName(node)}`,
            file,
            line: lineOf(source, node),
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return findings
}

function testReference(value: string): { file: string; title: string } | null {
  const separator = value.indexOf(': ')
  if (separator < 1 || separator + 2 >= value.length) return null
  return { file: value.slice(0, separator), title: value.slice(separator + 2) }
}

function containsTestTitle(file: string, text: string, title: string): boolean {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'test' || node.expression.text === 'it') &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === title
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function counts(findings: readonly { file: string }[]): Record<string, number> {
  const result: Record<string, number> = {}
  for (const finding of findings) result[finding.file] = (result[finding.file] ?? 0) + 1
  return result
}

function ratchetViolations(
  label: string,
  findings: readonly { file: string; line: number }[],
  baseline: Record<string, number>,
): string[] {
  const current = counts(findings)
  const violations: string[] = []
  for (const finding of findings) {
    const index = findings.filter((candidate) => candidate.file === finding.file).indexOf(finding)
    if (index >= (baseline[finding.file] ?? 0))
      violations.push(`${finding.file}:${finding.line}: new ${label} is not allowed`)
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const actual = current[file] ?? 0
    if (actual < allowed)
      violations.push(
        `${file}: ${label} baseline may only shrink; lower its count from ${allowed} to ${actual}`,
      )
  }
  return violations
}

export function refusalRemedyViolations(
  findings: RefusalRemedyFindings,
  baseline: RefusalRemedyBaseline,
  testFiles: Readonly<Record<string, string>> = {},
): string[] {
  const violations = [
    ...ratchetViolations('raw cleared-by literal', findings.rawLiterals, baseline.rawLiterals),
    ...ratchetViolations(
      'shape-built refusal without a remedy',
      findings.missingRemedies,
      baseline.missingRemedies,
    ),
  ]
  const actualCommands = new Set(findings.commandRemedies.map(({ id }) => id))
  for (const finding of findings.commandRemedies) {
    const record = baseline.commandCases[finding.id]
    if (!record)
      violations.push(
        `${finding.file}:${finding.line}: command remedy ${finding.id} needs a clearing test or exemption`,
      )
    else if (Boolean(record.test) === Boolean(record.exemption))
      violations.push(`${finding.id}: command remedy must record exactly one test or exemption`)
    else if (record.test) {
      const reference = testReference(record.test)
      if (!reference || !reference.file.endsWith('.test.ts')) {
        violations.push(`${finding.id}: clearing test must name a test file and title`)
      } else if (!(reference.file in testFiles)) {
        violations.push(`${finding.id}: clearing test file ${reference.file} does not exist`)
      } else if (!containsTestTitle(reference.file, testFiles[reference.file]!, reference.title)) {
        violations.push(
          `${finding.id}: clearing test file ${reference.file} does not contain test title "${reference.title}"`,
        )
      }
    }
  }
  for (const id of Object.keys(baseline.commandCases)) {
    if (!actualCommands.has(id)) violations.push(`${id}: stale command-remedy case must be removed`)
  }
  return violations
}

function check(): boolean {
  const files = Object.fromEntries(
    sourceFiles().map((path) => [path, readFileSync(resolve(ROOT, path), 'utf8')]),
  )
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as RefusalRemedyBaseline
  const findings = refusalRemedyFindings(files)
  const testFiles = Object.fromEntries(
    Object.values(baseline.commandCases)
      .flatMap((record) => (record.test ? [testReference(record.test)] : []))
      .filter((reference): reference is { file: string; title: string } => Boolean(reference))
      .filter(({ file }) => existsSync(resolve(ROOT, file)))
      .map(({ file }) => [file, readFileSync(resolve(ROOT, file), 'utf8')]),
  )
  const violations = refusalRemedyViolations(findings, baseline, testFiles)
  for (const violation of violations) console.error(violation)
  if (violations.length) return false
  console.log(
    `check-refusal-remedy: ok (${findings.rawLiterals.length} raw literals, ${findings.missingRemedies.length} shape-built refusals without remedies, ${findings.commandRemedies.length} command remedies)`,
  )
  return true
}

if (import.meta.main && !check()) process.exit(1)
