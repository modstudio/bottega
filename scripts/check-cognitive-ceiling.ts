#!/usr/bin/env bun
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import ts from 'typescript'
import { openChangeView } from '../shared/change-view'
import { type Finding, ratchetDecision } from '../shared/ratchet'
import { measuredSourceFiles } from './check-file-ceiling'
import { reportPathFromArguments, reportRemaining } from './remaining-report'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const CEILING = 15
const COMPLEXITY_RULE = 'sonarjs/cognitive-complexity'

type LintMessage = {
  ruleId: string | null
  severity: number
  line?: number
  column?: number
  message: string
  fatal?: boolean
}

type LintResult = {
  filePath: string
  messages: LintMessage[]
  fatalErrorCount?: number
}

type Reporter = Pick<Console, 'error' | 'log'>
function isFunctionImplementation(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  )
}
function functionBaseName(node: ts.FunctionLikeDeclaration): string {
  if (node.name) return node.name.getText()
  let parent: ts.Node | undefined = node.parent
  while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent))) {
    parent = parent.parent
  }
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text
  }
  if (parent && (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))) {
    return parent.name.getText()
  }
  if (parent && ts.isCallExpression(parent)) {
    if (parent.expression === node || parent.expression === node.parent) return 'IIFE'
    const called = ts.isPropertyAccessExpression(parent.expression)
      ? parent.expression.name.text
      : parent.expression.getText()
    return `${called} callback`
  }
  return '<anonymous>'
}

function namedFunctions(source: ts.SourceFile) {
  const functions: ts.FunctionLikeDeclaration[] = []
  const visit = (node: ts.Node) => {
    if (isFunctionImplementation(node)) functions.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  const bases = functions.map(functionBaseName)
  const totals = new Map<string, number>()
  for (const base of bases) totals.set(base, (totals.get(base) ?? 0) + 1)
  const seen = new Map<string, number>()
  return functions.map((node, index) => {
    const base = bases[index]!
    const occurrence = (seen.get(base) ?? 0) + 1
    seen.set(base, occurrence)
    return { node, name: totals.get(base) === 1 ? base : `${base}#${occurrence}` }
  })
}

function complexityScore(message: string) {
  const score = Number(message.match(/from (\d+) to/)?.[1])
  if (!Number.isFinite(score)) throw new Error(`could not read complexity: ${message}`)
  return score
}

export function complexityFindings(file: string, text: string, messages: LintMessage[]): Finding[] {
  const diagnostics = messages.filter(
    (message) =>
      message.ruleId === COMPLEXITY_RULE &&
      message.line !== undefined &&
      message.column !== undefined,
  )
  if (!diagnostics.length) return []
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const functions = namedFunctions(source)
  return diagnostics.map((message) => {
    const position = source.getPositionOfLineAndCharacter(message.line! - 1, message.column! - 1)
    const symbol = functions
      .filter(({ node }) => node.getStart(source) <= position && position <= node.getEnd())
      .at(-1)?.name
    const score = complexityScore(message.message)
    return {
      file,
      line: message.line!,
      rule: 'cognitive-complexity',
      message: `complexity ${score}, limit ${CEILING}`,
      symbol: symbol ?? '<anonymous>',
      measure: score,
    }
  })
}

function lintFailed(result: LintResult) {
  return Boolean(result.fatalErrorCount) || result.messages.some((message) => message.fatal)
}

async function lintText(eslint: ESLint, path: string, text: string) {
  const results = (await eslint.lintText(text, { filePath: resolve(ROOT, path) })) as LintResult[]
  const result = results[0]
  if (!result) throw new Error(`ESLint returned no result for ${path}`)
  return result
}

async function measureChangedFile(
  eslint: ESLint,
  view: ReturnType<typeof openChangeView>,
  entry: ReturnType<typeof openChangeView>['entries'][number],
  reporter: Reporter,
) {
  const headContent = view.headContent(entry.path)
  if (headContent.status === 'absent') {
    throw new Error(`check-cognitive-ceiling could not read HEAD:${entry.path}`)
  }
  const headResult = await lintText(eslint, entry.path, headContent.text)
  if (lintFailed(headResult)) {
    throw new Error(`check-cognitive-ceiling could not lint head content for ${entry.path}`)
  }
  const head = complexityFindings(entry.path, headContent.text, headResult.messages)
  const baseContent = view.baseContent(entry.path)
  if (baseContent.status === 'absent') return { base: [], head, baseFailed: false }
  const basePath = view.facts.renames.get(entry.path) ?? entry.path
  try {
    const baseResult = await lintText(eslint, basePath, baseContent.text)
    if (lintFailed(baseResult)) throw new Error('ESLint reported a fatal diagnostic')
    return {
      base: complexityFindings(basePath, baseContent.text, baseResult.messages),
      head,
      baseFailed: false,
    }
  } catch (error) {
    reporter.error(
      `${entry.path}: base content could not be linted: ${error instanceof Error ? error.message : String(error)}`,
    )
    return { base: [], head, baseFailed: true }
  }
}

async function changedMeasurements(
  eslint: ESLint,
  view: ReturnType<typeof openChangeView>,
  measuredPaths: Set<string>,
  reporter: Reporter,
) {
  const before: Finding[] = []
  const after: Finding[] = []
  const baseFailures = new Set<string>()
  for (const entry of view.entries) {
    if (entry.status === 'D' || !measuredPaths.has(entry.path)) continue
    const measurement = await measureChangedFile(eslint, view, entry, reporter)
    before.push(...measurement.base)
    after.push(...measurement.head)
    if (measurement.baseFailed) baseFailures.add(entry.path)
  }
  return { base: before, head: after, facts: view.facts, baseFailures }
}

async function wholeTreeMeasurements(eslint: ESLint) {
  const results = (await eslint.lintFiles(
    measuredSourceFiles().map(({ absolute }) => absolute),
  )) as LintResult[]
  const violations: string[] = []
  let remaining = 0
  for (const result of results) {
    const file = relative(ROOT, result.filePath)
    for (const message of result.messages) {
      if (message.ruleId === COMPLEXITY_RULE) {
        remaining += 1
      } else if (message.severity === 2) {
        violations.push(
          `${file}:${message.line ?? 1} ${message.ruleId ?? '<unknown>'} ${message.message}`,
        )
      }
    }
  }
  return { remaining, violations }
}

function violationLine(finding: ReturnType<typeof ratchetDecision>[number]) {
  const previous = finding.reason === 'grew' ? `, previous score ${finding.previousMeasure}` : ''
  return (
    `${finding.file}:${finding.line} ${finding.symbol}: complexity ${finding.measure}, ` +
    `limit ${CEILING}${previous}; extract a decision ` +
    '(canon 10-code: Respect the complexity ceiling)'
  )
}

export async function changedComplexityViolations(
  eslint: ESLint,
  view: ReturnType<typeof openChangeView>,
  measuredPaths: Set<string>,
  reporter: Reporter = console,
) {
  const change = await changedMeasurements(eslint, view, measuredPaths, reporter)
  return ratchetDecision({
    base: change.base,
    head: change.head,
    change: change.facts,
    unanalysedBase: change.baseFailures,
  }).map(violationLine)
}

async function checkCognitiveCeiling(
  base: string,
  reportPath?: string,
  reporter: Reporter = console,
) {
  const eslint = new ESLint({ cwd: ROOT })
  const wholeTree = await wholeTreeMeasurements(eslint)
  reporter.log(`cognitive complexity: ${wholeTree.remaining} functions over ${CEILING} remain`)
  reportRemaining(reportPath, wholeTree.remaining)
  const view = openChangeView({ cwd: ROOT, base, mode: 'worktree' })
  const measuredPaths = new Set(measuredSourceFiles().map((file) => file.path))
  const violations = [
    ...wholeTree.violations,
    ...(await changedComplexityViolations(eslint, view, measuredPaths, reporter)),
  ]
  for (const violation of violations) reporter.error(violation)
  if (violations.length) return false
  reporter.log('check-cognitive-ceiling: ok')
  return true
}

function parseArguments(argv: string[]) {
  const base = argv.find((argument) => argument.startsWith('--base='))?.slice(7)
  const report = reportPathFromArguments(argv)
  if (
    base &&
    argv.every((argument) => argument.startsWith('--base=') || argument.startsWith('--report='))
  )
    return { base, report }
  throw new Error('usage: check-cognitive-ceiling.ts --base=<ref>')
}

if (import.meta.main) {
  try {
    const { base, report } = parseArguments(Bun.argv.slice(2))
    if (!(await checkCognitiveCeiling(base, report))) process.exit(1)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
