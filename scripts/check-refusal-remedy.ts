import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
  return ['orchestrator/src/**/*.ts', 'shared/**/*.ts', 'hub/src/**/*.ts', 'cli/**/*.ts']
    .flatMap((pattern) => [...new Glob(pattern).scanSync({ cwd: ROOT, onlyFiles: true })])
    .filter(productionPath)
    .sort()
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

function propertyNamed(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | null {
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

function enclosingName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) &&
      current.name
    )
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
    const visit = (node: ts.Node): void => {
      if (
        file !== RENDERER &&
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) &&
        node.text.includes('cleared by:')
      ) {
        findings.rawLiterals.push({ file, line: lineOf(source, node) })
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === 'refusal' || node.expression.text === 'refusalValue')
      ) {
        if (!node.arguments[1])
          findings.missingRemedies.push({ file, line: lineOf(source, node) })
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
  }
  for (const id of Object.keys(baseline.commandCases)) {
    if (!actualCommands.has(id))
      violations.push(`${id}: stale command-remedy case must be removed`)
  }
  return violations
}

function check(): boolean {
  const files = Object.fromEntries(
    sourceFiles().map((path) => [path, readFileSync(resolve(ROOT, path), 'utf8')]),
  )
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as RefusalRemedyBaseline
  const findings = refusalRemedyFindings(files)
  const violations = refusalRemedyViolations(findings, baseline)
  for (const violation of violations) console.error(violation)
  if (violations.length) return false
  console.log(
    `check-refusal-remedy: ok (${findings.rawLiterals.length} raw literals, ${findings.missingRemedies.length} shape-built refusals without remedies)`,
  )
  return true
}

if (import.meta.main && !check()) process.exit(1)
