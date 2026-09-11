#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'
import ts from 'typescript'
import { ESLint } from 'eslint'
import { measuredSourceFiles } from './check-file-ceiling'
import { decideCeiling } from './quality/ceiling-decision'

type FrozenFunction = { file: string; function: string; line: number; score: number }
type MeasuredFunction = FrozenFunction & { key: string }

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const STATE_FILE = `${ROOT}/scripts/quality/cognitive-ceiling.json`
const CEILING = 15

function functionBaseName(node: ts.FunctionLikeDeclaration): string {
  if (node.name) return node.name.getText()
  let parent: ts.Node | undefined = node.parent
  while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent))) {
    parent = parent.parent
  }
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
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
    if (ts.isFunctionLike(node)) functions.push(node)
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

function functionAt(file: string, line: number, column: number): string {
  const content = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const position = source.getPositionOfLineAndCharacter(line - 1, column - 1)
  const containing = namedFunctions(source).filter(({ node }) =>
    node.getStart(source) <= position && position <= node.getEnd())
  return containing.at(-1)?.name ?? '<anonymous>'
}

function readState(): FrozenFunction[] {
  if (!existsSync(STATE_FILE)) return []
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as FrozenFunction[]
}

function keyOf(entry: Pick<FrozenFunction, 'file' | 'function'>) {
  return `${entry.file}\0${entry.function}`
}

function writeState(entries: FrozenFunction[]) {
  entries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  writeFileSync(STATE_FILE, `${JSON.stringify(entries, null, 2)}\n`)
}

export async function measureCognitiveComplexity(): Promise<MeasuredFunction[]> {
  const results = await new ESLint({ cwd: ROOT }).lintFiles(measuredSourceFiles().map(({ absolute }) => absolute))
  return results.flatMap((result) => result.messages.flatMap((message) => {
    if (message.ruleId !== 'sonarjs/cognitive-complexity' || !message.line || !message.column) return []
    const score = Number(message.message.match(/from (\d+) to/)?.[1])
    if (!Number.isFinite(score)) throw new Error(`could not read complexity: ${message.message}`)
    const file = relative(ROOT, result.filePath)
    const functionName = functionAt(result.filePath, message.line, message.column)
    const entry = { file, function: functionName, line: message.line, score }
    return [{ ...entry, key: keyOf(entry) }]
  }))
}

export async function checkCognitiveCeiling() {
  const frozen = readState()
  const frozenByKey = new Map(frozen.map((entry) => [keyOf(entry), entry]))
  const measured = await measureCognitiveComplexity()
  const measuredKeys = new Set(measured.map(({ key }) => key))
  const next = frozen.filter((entry) => measuredKeys.has(keyOf(entry))).map((entry) => ({ ...entry }))
  const nextByKey = new Map(next.map((entry) => [keyOf(entry), entry]))
  const violations: string[] = []
  for (const current of measured) {
    const prior = frozenByKey.get(current.key)
    const decision = decideCeiling({
      key: current.key, value: current.score, frozen: prior?.score, ceiling: CEILING,
    })
    if (decision === 'lower') Object.assign(nextByKey.get(current.key)!, current)
    if (decision === 'fail') {
      violations.push(
        `${current.file}:${current.line} ${current.function}: complexity ${current.score}, ` +
        `frozen at ${prior?.score ?? CEILING}; extract a decision (architecture-rules 16)`,
      )
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(frozen)) writeState(next)
  if (violations.length) {
    for (const violation of violations) console.error(violation)
    return false
  }
  console.log(`check-cognitive-ceiling: ok (${measured.length} frozen functions)`)
  return true
}

if (import.meta.main && !await checkCognitiveCeiling()) process.exit(1)
