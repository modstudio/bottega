import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Glob } from 'bun'
import { getTableName } from 'drizzle-orm'
import ts from 'typescript'
import { HOSTED_SECRET_TABLES, hostedSecretColumns } from '../shared/hosted-secret-mask.ts'

type TablePolicy = { freeText: ReadonlySet<string> }

/** Derived from the same Drizzle/exclusion inventory used by the writer and audit. */
function tablePolicies(): ReadonlyMap<string, TablePolicy> {
  return new Map(
    HOSTED_SECRET_TABLES.filter((entry) => entry.mask).map((entry) => [
      getTableName(entry.table),
      { freeText: new Set(hostedSecretColumns(entry).map((column) => column.name)) },
    ]),
  )
}

type HostedWriterFinding = { file: string; table: string; line: number; reason: string }
type HostedWriterVerdicts = { masked: number; structured: number }
type SqlWrite = { table: string; columns: Map<string, readonly ts.Expression[]> }

function splitSqlList(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '(' || character === '[') depth += 1
    else if (character === ')' || character === ']') depth -= 1
    else if (character === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts
}

function matchingClose(value: string, open: number): number {
  let depth = 0
  for (let index = open; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1
    else if (value[index] === ')' && --depth === 0) return index
  }
  return -1
}

function expressionIndexes(fragment: string): number[] {
  return [...fragment.matchAll(/__EXPR_(\d+)__/g)].map((match) => Number(match[1]))
}

function sqlWrite(node: ts.TaggedTemplateExpression): SqlWrite | null {
  if (!ts.isIdentifier(node.tag) || node.tag.text !== 'tx') return null
  const expressions: ts.Expression[] = []
  let sql: string
  if (ts.isNoSubstitutionTemplateLiteral(node.template)) sql = node.template.text
  else {
    sql = node.template.head.text
    node.template.templateSpans.forEach((span, index) => {
      expressions.push(span.expression)
      sql += `__EXPR_${index}__${span.literal.text}`
    })
  }
  const normalized = sql.replace(/\s+/g, ' ').trim()
  const insert = normalized.match(/^INSERT\s+INTO\s+([a-z0-9_]+)\s*/i)
  if (insert) {
    const columnOpen = normalized.indexOf('(', insert[0].length - 1)
    const columnClose = matchingClose(normalized, columnOpen)
    const afterColumns = normalized.slice(columnClose + 1)
    const valuesMatch = /\bVALUES\s*/i.exec(afterColumns)
    if (columnOpen < 0 || columnClose < 0 || !valuesMatch) return null
    const valuesOpen = normalized.indexOf('(', columnClose + 1 + valuesMatch.index)
    const valuesClose = matchingClose(normalized, valuesOpen)
    if (valuesOpen < 0 || valuesClose < 0) return null
    const names = splitSqlList(normalized.slice(columnOpen + 1, columnClose))
    const values = splitSqlList(normalized.slice(valuesOpen + 1, valuesClose))
    return {
      table: insert[1]!.toLowerCase(),
      columns: new Map(
        names.map((name, index) => [
          name.replaceAll('"', '').trim().toLowerCase(),
          expressionIndexes(values[index] ?? '').map((expression) => expressions[expression]!),
        ]),
      ),
    }
  }
  const update = normalized.match(/^UPDATE\s+([a-z0-9_]+)\s+SET\s+([\s\S]*)$/i)
  if (!update) return null
  const assignments = update[2]!.split(/\s+WHERE\s+/i, 1)[0]!
  return {
    table: update[1]!.toLowerCase(),
    columns: new Map(
      splitSqlList(assignments).flatMap((assignment) => {
        const match = assignment.match(/^\s*"?([a-z0-9_]+)"?\s*=([\s\S]*)$/i)
        return match
          ? [
              [
                match[1]!.toLowerCase(),
                expressionIndexes(match[2]!).map((index) => expressions[index]!),
              ],
            ]
          : []
      }),
    ),
  }
}

function namedFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) return current
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent)
    )
      return current
  }
  return null
}

function containsIdentifier(node: ts.Node, names: ReadonlySet<string>): boolean {
  let found = false
  const visit = (child: ts.Node) => {
    if (ts.isIdentifier(child) && names.has(child.text)) found = true
    if (!found) ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function precedingMaskBindings(scope: ts.FunctionLikeDeclaration, table: string, before: number) {
  const bindings = new Set<string>()
  const masksTable = (node: ts.Node) => {
    let found = false
    const visitCall = (child: ts.Node) => {
      if (
        ts.isCallExpression(child) &&
        ts.isIdentifier(child.expression) &&
        child.expression.text === 'maskHostedTableWrite' &&
        child.arguments[0]?.getText().includes(`'${table}'`)
      )
        found = true
      if (!found) ts.forEachChild(child, visitCall)
    }
    visitCall(node)
    return found
  }
  const visit = (node: ts.Node): void => {
    if (node.getStart() >= before) return
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (masksTable(node.initializer) || containsIdentifier(node.initializer, bindings))
    )
      bindings.add(node.name.text)
    if (ts.isPropertyAssignment(node) && node.initializer && masksTable(node.initializer)) {
      if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) bindings.add(node.name.text)
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (masksTable(node.right) || containsIdentifier(node.right, bindings))
    ) {
      if (ts.isIdentifier(node.left)) bindings.add(node.left.text)
      else if (ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression))
        bindings.add(node.left.expression.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(scope)
  return bindings
}

function expressionUsesBinding(expression: ts.Expression, bindings: ReadonlySet<string>): boolean {
  let found = false
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && bindings.has(node.text)) found = true
    if (!found) ts.forEachChild(node, visit)
  }
  visit(expression)
  return found
}

function inspectHostedWriters(
  file: string,
  source: string,
): {
  findings: HostedWriterFinding[]
  verdicts: HostedWriterVerdicts
} {
  const policies = tablePolicies()
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const findings: HostedWriterFinding[] = []
  const verdicts: HostedWriterVerdicts = { masked: 0, structured: 0 }
  const visit = (node: ts.Node) => {
    if (!ts.isTaggedTemplateExpression(node)) {
      ts.forEachChild(node, visit)
      return
    }
    const write = sqlWrite(node)
    const policy = write && policies.get(write.table)
    if (!write || !policy) {
      ts.forEachChild(node, visit)
      return
    }
    const freeText = [...write.columns].filter(([column]) => policy.freeText.has(column))
    if (!freeText.length) {
      verdicts.structured += 1
      ts.forEachChild(node, visit)
      return
    }
    verdicts.masked += 1
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
    const scope = namedFunction(node)
    const bindings = scope
      ? precedingMaskBindings(scope, write.table, node.getStart())
      : new Set<string>()
    if (!bindings.size) {
      findings.push({ file, table: write.table, line, reason: 'no preceding masked binding' })
    } else {
      const unmasked = freeText.flatMap(([column, expressions]) =>
        expressions.length &&
        !expressions.every((expression) => expressionUsesBinding(expression, bindings))
          ? [column]
          : [],
      )
      if (unmasked.length)
        findings.push({
          file,
          table: write.table,
          line,
          reason: `unmasked interpolation for ${unmasked.join(', ')}`,
        })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { findings, verdicts }
}

function hostedWriterFindings(file: string, source: string): HostedWriterFinding[] {
  return inspectHostedWriters(file, source).findings
}

async function currentHostedWriterInspection(root = resolve(import.meta.dir, '..')) {
  const findings: HostedWriterFinding[] = []
  const verdicts: HostedWriterVerdicts = { masked: 0, structured: 0 }
  for (const pattern of ['hub/src/**/*.ts', 'orchestrator/src/record/**/*.ts']) {
    for await (const file of new Glob(pattern).scan({ cwd: root })) {
      if (file.endsWith('.test.ts') || file.includes('/migrations')) continue
      const source = readFileSync(resolve(root, file), 'utf8')
      if (!source.includes('tx`')) continue
      const inspected = inspectHostedWriters(file, source)
      findings.push(...inspected.findings)
      verdicts.masked += inspected.verdicts.masked
      verdicts.structured += inspected.verdicts.structured
    }
  }
  return { findings, verdicts }
}

async function currentHostedWriterFindings(root = resolve(import.meta.dir, '..')) {
  return (await currentHostedWriterInspection(root)).findings
}

export const hostedWriterGuard = {
  currentFindings: currentHostedWriterFindings,
  currentInspection: currentHostedWriterInspection,
  findings: hostedWriterFindings,
  inspect: inspectHostedWriters,
}

if (import.meta.main) {
  const { runHostedSecretWriterGuard } = await import('./hosted-secret-writer-guard-runner.ts')
  await runHostedSecretWriterGuard()
}
