import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Glob } from 'bun'
import { getTableColumns, getTableName } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import ts from 'typescript'
import { HOSTED_SECRET_TABLES, hostedSecretColumns } from '../shared/hosted-secret-mask.ts'

type TablePolicy = { freeText: ReadonlySet<string>; columns: ReadonlySet<string> }

/** Derived from the same Drizzle/exclusion inventory used by the writer and audit. */
function tablePolicies(): ReadonlyMap<string, TablePolicy> {
  return new Map(
    HOSTED_SECRET_TABLES.filter((entry) => entry.mask).map((entry) => [
      getTableName(entry.table),
      {
        freeText: new Set(
          Object.entries(getTableColumns(entry.table)).flatMap(([property, column]) =>
            hostedSecretColumns(entry).includes(column as AnyPgColumn)
              ? [property, (column as AnyPgColumn).name]
              : [],
          ),
        ),
        columns: new Set(
          Object.entries(getTableColumns(entry.table)).flatMap(([property, column]) => [
            property,
            (column as AnyPgColumn).name,
          ]),
        ),
      },
    ]),
  )
}

type HostedWriterFinding = { file: string; table: string; line: number; reason: string }
type HostedWriterVerdicts = { masked: number; structured: number }
type BuilderVerdict = 'masked' | 'structured-only' | 'outside-inventory'
type BuilderSite = {
  file: string
  line: number
  table: string
  operation: 'insert' | 'update'
  verdict: BuilderVerdict
}
type SqlWrite = { table: string; columns: Map<string, readonly ts.Expression[]> }

function schemaTableName(source: string, exported: string): string | null {
  const file = ts.createSourceFile(
    'schema.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  let found: string | null = null
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === exported &&
      node.initializer
    ) {
      const findTableCall = (child: ts.Node): void => {
        if (
          ts.isCallExpression(child) &&
          child.arguments[0] &&
          ts.isStringLiteral(child.arguments[0]) &&
          child.expression.getText(file).includes('pgTable')
        )
          found = child.arguments[0].text
        if (!found) ts.forEachChild(child, findTableCall)
      }
      findTableCall(node.initializer)
    }
    if (!found) ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

function importedTableBindings(
  file: string,
  sourceFile: ts.SourceFile,
  root: string,
): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>()
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.includes('/record/schema') ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    )
      continue
    const module = resolve(resolve(root, file), '..', statement.moduleSpecifier.text)
    const schemaPath = module.endsWith('.ts') ? module : `${module}.ts`
    let schema: string
    try {
      schema = readFileSync(schemaPath, 'utf8')
    } catch {
      continue
    }
    for (const element of statement.importClause.namedBindings.elements) {
      const table = schemaTableName(schema, (element.propertyName ?? element.name).text)
      if (table) bindings.set(element.name.text, table)
    }
  }
  return bindings
}

function builderWrite(
  node: ts.CallExpression,
  tableBindings: ReadonlyMap<string, string>,
): { table: string; operation: 'insert' | 'update'; value: ts.Expression } | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null
  const terminal = node.expression.name.text
  if (terminal !== 'values' && terminal !== 'set') return null
  const value = node.arguments[0]
  const receiver = node.expression.expression
  if (
    !value ||
    !ts.isCallExpression(receiver) ||
    !ts.isPropertyAccessExpression(receiver.expression)
  )
    return null
  const operation = receiver.expression.name.text
  if (operation !== 'insert' && operation !== 'update') return null
  const table = receiver.arguments[0]
  if (!table || !ts.isIdentifier(table)) return null
  const tableName = tableBindings.get(table.text)
  return tableName ? { table: tableName, operation, value } : null
}

function objectShape(
  value: ts.Expression,
): { properties: Map<string, ts.Expression>; spreads: ts.Expression[] } | null {
  if (!ts.isObjectLiteralExpression(value)) return null
  const properties = new Map<string, ts.Expression>()
  const spreads: ts.Expression[] = []
  for (const property of value.properties) {
    if (ts.isSpreadAssignment(property)) spreads.push(property.expression)
    else if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    )
      properties.set(property.name.text, property.initializer)
    else if (ts.isShorthandPropertyAssignment(property))
      properties.set(property.name.text, property.name)
  }
  return { properties, spreads }
}

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

function maskHelperNames(sourceFile: ts.SourceFile, table: string): ReadonlySet<string> {
  const helpers = new Set<string>()
  const containsDirectMask = (node: ts.Node) => {
    let found = false
    const visit = (child: ts.Node) => {
      if (
        ts.isCallExpression(child) &&
        ts.isIdentifier(child.expression) &&
        child.expression.text === 'maskHostedTableWrite' &&
        child.arguments[0]?.getText(sourceFile).includes(`'${table}'`)
      )
        found = true
      if (!found) ts.forEachChild(child, visit)
    }
    visit(node)
    return found
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      containsDirectMask(node.initializer)
    )
      helpers.add(node.name.text)
    if (ts.isFunctionDeclaration(node) && node.name && containsDirectMask(node))
      helpers.add(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return helpers
}

function precedingMaskBindings(
  scope: ts.FunctionLikeDeclaration,
  table: string,
  before: number,
  helpers: ReadonlySet<string> = new Set(),
) {
  const bindings = new Set<string>()
  const masksTable = (node: ts.Node) => {
    let found = false
    const visitCall = (child: ts.Node) => {
      if (
        ts.isCallExpression(child) &&
        ts.isIdentifier(child.expression) &&
        ((child.expression.text === 'maskHostedTableWrite' &&
          child.arguments[0]?.getText().includes(`'${table}'`)) ||
          helpers.has(child.expression.text))
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

type WriteInspection = {
  finding?: HostedWriterFinding
  verdict?: keyof HostedWriterVerdicts
  builderSite?: BuilderSite
}

function bindingsForWrite(
  node: ts.Node,
  table: string,
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const scope = namedFunction(node)
  return scope
    ? precedingMaskBindings(scope, table, node.getStart(), maskHelperNames(sourceFile, table))
    : new Set<string>()
}

function builderNodeInspection(
  node: ts.CallExpression,
  file: string,
  sourceFile: ts.SourceFile,
  tableBindings: ReadonlyMap<string, string>,
  policies: ReadonlyMap<string, TablePolicy>,
): WriteInspection | null {
  const write = builderWrite(node, tableBindings)
  if (!write) return null
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
  const site = { file, line, table: write.table, operation: write.operation } as const
  const policy = policies.get(write.table)
  if (!policy) return { builderSite: { ...site, verdict: 'outside-inventory' } }
  const bindings = bindingsForWrite(node, write.table, sourceFile)
  const shape = objectShape(write.value)
  const directMasked = shape === null && expressionUsesBinding(write.value, bindings)
  const spreadMasked = shape?.spreads.some((spread) => expressionUsesBinding(spread, bindings))
  const propertyMasked = [...(shape?.properties.values() ?? [])].some((property) =>
    expressionUsesBinding(property, bindings),
  )
  const unknownSpread = shape?.spreads.some((spread) => !expressionUsesBinding(spread, bindings))
  const freeText = [...(shape?.properties ?? [])].filter(([key]) => policy.freeText.has(key))
  const unmaskedFreeText = freeText.filter(
    ([, expression]) => !expressionUsesBinding(expression, bindings),
  )
  const unknownKeys = [...(shape?.properties.keys() ?? [])].filter(
    (key) => !policy.columns.has(key),
  )
  const hasMaskedValue = directMasked || spreadMasked || propertyMasked
  const structured =
    !hasMaskedValue &&
    shape !== null &&
    freeText.length === 0 &&
    unknownKeys.length === 0 &&
    !unknownSpread
  if (structured)
    return { verdict: 'structured', builderSite: { ...site, verdict: 'structured-only' } }
  const builderSite: BuilderSite = { ...site, verdict: 'masked' }
  if (!hasMaskedValue)
    return {
      verdict: 'masked',
      builderSite,
      finding: {
        file,
        line,
        table: write.table,
        reason: 'builder values have no preceding masked binding',
      },
    }
  if (!unknownSpread && !unmaskedFreeText.length) return { verdict: 'masked', builderSite }
  return {
    verdict: 'masked',
    builderSite,
    finding: {
      file,
      line,
      table: write.table,
      reason: unknownSpread
        ? 'builder values include an unmasked spread'
        : `builder values include unmasked free-text keys: ${unmaskedFreeText.map(([key]) => key).join(', ')}`,
    },
  }
}

function sqlNodeInspection(
  node: ts.TaggedTemplateExpression,
  file: string,
  sourceFile: ts.SourceFile,
  policies: ReadonlyMap<string, TablePolicy>,
): WriteInspection | null {
  const write = sqlWrite(node)
  const policy = write && policies.get(write.table)
  if (!write || !policy) return null
  const freeText = [...write.columns].filter(([column]) => policy.freeText.has(column))
  if (!freeText.length) return { verdict: 'structured' }
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
  const bindings = bindingsForWrite(node, write.table, sourceFile)
  if (!bindings.size)
    return {
      verdict: 'masked',
      finding: { file, table: write.table, line, reason: 'no preceding masked binding' },
    }
  const unmasked = freeText.flatMap(([column, expressions]) =>
    expressions.length &&
    !expressions.every((expression) => expressionUsesBinding(expression, bindings))
      ? [column]
      : [],
  )
  return {
    verdict: 'masked',
    ...(unmasked.length
      ? {
          finding: {
            file,
            table: write.table,
            line,
            reason: `unmasked interpolation for ${unmasked.join(', ')}`,
          },
        }
      : {}),
  }
}

function inspectHostedWriters(
  file: string,
  source: string,
  root = resolve(import.meta.dir, '..'),
): {
  findings: HostedWriterFinding[]
  verdicts: HostedWriterVerdicts
  builderSites: BuilderSite[]
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
  const builderSites: BuilderSite[] = []
  const tableBindings = importedTableBindings(file, sourceFile, root)
  const record = (inspected: WriteInspection | null) => {
    if (!inspected) return
    if (inspected.finding) findings.push(inspected.finding)
    if (inspected.verdict) verdicts[inspected.verdict] += 1
    if (inspected.builderSite) builderSites.push(inspected.builderSite)
  }
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node))
      record(builderNodeInspection(node, file, sourceFile, tableBindings, policies))
    if (ts.isTaggedTemplateExpression(node))
      record(sqlNodeInspection(node, file, sourceFile, policies))
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { findings, verdicts, builderSites }
}

function hostedWriterFindings(file: string, source: string): HostedWriterFinding[] {
  return inspectHostedWriters(file, source).findings
}

async function currentHostedWriterInspection(root = resolve(import.meta.dir, '..')) {
  const findings: HostedWriterFinding[] = []
  const verdicts: HostedWriterVerdicts = { masked: 0, structured: 0 }
  const builderSites: BuilderSite[] = []
  for (const pattern of ['hub/src/**/*.ts', 'orchestrator/src/record/**/*.ts']) {
    for await (const file of new Glob(pattern).scan({ cwd: root })) {
      if (file.endsWith('.test.ts') || file.includes('/migrations')) continue
      const source = readFileSync(resolve(root, file), 'utf8')
      const inspected = inspectHostedWriters(file, source, root)
      findings.push(...inspected.findings)
      verdicts.masked += inspected.verdicts.masked
      verdicts.structured += inspected.verdicts.structured
      builderSites.push(...inspected.builderSites)
    }
  }
  return { findings, verdicts, builderSites }
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
  await import('./hosted-secret-writer-guard-runner.ts')
}
