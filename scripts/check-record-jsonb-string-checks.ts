#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export type JsonbColumn = { table: string; column: string }

export const NEVER_VALIDATED_JSONB_CHECKS: readonly {
  table: string
  column: string
  reason: string
}[] = [
  {
    table: 'doc_revision',
    column: 'source_files',
    reason:
      'historical non-array strings left by the dev_1303 repair; the 2026-10-31 record rehearsal failed its VALIDATE and the row count was not established',
  },
  {
    table: 'doc_revision',
    column: 'related_subject_ids',
    reason:
      'historical non-array strings left by the dev_1303 repair; the 2026-10-31 record rehearsal failed its VALIDATE and the row count was not established',
  },
  {
    table: 'operator_waiting_email',
    column: 'options',
    reason:
      '5 historical top-level string rows measured by the 2026-10-31 diagnostic record rehearsal',
  },
]

function callNamed(expression: ts.Expression, name: string): ts.CallExpression | undefined {
  let current = expression
  while (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) {
    if (ts.isCallExpression(current)) {
      if (ts.isIdentifier(current.expression) && current.expression.text === name) return current
      current = current.expression
    } else {
      current = current.expression
    }
  }
  return undefined
}

function propertyName(property: ts.PropertyAssignment): string | undefined {
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text
  return undefined
}

function tableCall(
  node: ts.CallExpression,
): { table: string; shape: ts.ObjectLiteralExpression } | undefined {
  const isTable = ts.isPropertyAccessExpression(node.expression)
    ? node.expression.name.text === 'withRLS'
    : ts.isIdentifier(node.expression) && node.expression.text === 'pgTable'
  const table = node.arguments[0]
  const shape = node.arguments[1]
  if (!isTable || !table || !ts.isStringLiteral(table) || !shape) return undefined
  if (!ts.isObjectLiteralExpression(shape)) return undefined
  return { table: table.text, shape }
}

function tableJsonbColumns(table: string, shape: ts.ObjectLiteralExpression): JsonbColumn[] {
  const columns: JsonbColumn[] = []
  for (const property of shape.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const jsonb = callNamed(property.initializer, 'jsonb')
    if (!jsonb) continue
    const fallback = propertyName(property)
    const declared = jsonb.arguments[0]
    const column = declared && ts.isStringLiteral(declared) ? declared.text : fallback
    if (column) columns.push({ table, column })
  }
  return columns
}

export function jsonbColumns(sourceText: string, file = 'schema.ts'): JsonbColumn[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true)
  const columns: JsonbColumn[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const definition = tableCall(node)
      if (definition) columns.push(...tableJsonbColumns(definition.table, definition.shape))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return columns
}

export function jsonbStringCheckName(column: JsonbColumn): string {
  return `${column.table}_${column.column}_not_json_string_check`
}

export function missingJsonbStringChecks(
  schemas: readonly { file: string; source: string }[],
  migrationSql: string,
): string[] {
  return schemas
    .flatMap(({ file, source }) => jsonbColumns(source, file))
    .filter((column) => {
      const name = jsonbStringCheckName(column)
      const expression = `jsonb_typeof("${column.column}") <> 'string'`
      return !migrationSql.includes(`CONSTRAINT "${name}" CHECK (${expression}) NOT VALID`)
    })
    .map((column) => `${column.table}.${column.column}`)
    .sort()
}

function columnKey(column: JsonbColumn): string {
  return `${column.table}.${column.column}`
}

function hasValidation(migrationSql: string, column: JsonbColumn): boolean {
  const name = jsonbStringCheckName(column)
  return migrationSql.includes(`ALTER TABLE "${column.table}" VALIDATE CONSTRAINT "${name}"`)
}

export function jsonbStringValidationFailures(
  schemas: readonly { file: string; source: string }[],
  migrationSql: string,
  neverValidated: readonly { table: string; column: string }[] = NEVER_VALIDATED_JSONB_CHECKS,
): string[] {
  const columns = schemas.flatMap(({ file, source }) => jsonbColumns(source, file))
  const hosted = new Set(columns.map(columnKey))
  const excluded = new Set(neverValidated.map(columnKey))
  const failures = neverValidated
    .filter((column) => !hosted.has(columnKey(column)))
    .map(
      (column) =>
        `${columnKey(column)}: NEVER_VALIDATED_JSONB_CHECKS entry is not a hosted jsonb column`,
    )

  for (const column of columns) {
    const key = columnKey(column)
    const validated = hasValidation(migrationSql, column)
    if (excluded.has(key) && validated) {
      failures.push(
        `${key}: NEVER_VALIDATED_JSONB_CHECKS columns must not have a VALIDATE statement`,
      )
    } else if (!excluded.has(key) && !validated) {
      failures.push(
        `${key}: hosted jsonb columns not in NEVER_VALIDATED_JSONB_CHECKS require a VALIDATE statement`,
      )
    }
  }
  return failures.sort()
}

function run(): number {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const record = join(root, 'shared', 'record')
  const schemas = readdirSync(record)
    .filter((file) => /^schema(?:-[^.]+)?\.ts$/.test(file))
    .map((file) => ({ file, source: readFileSync(join(record, file), 'utf8') }))
  const columns = schemas.flatMap(({ file, source }) => jsonbColumns(source, file))
  if (columns.length === 0) {
    console.error(`record jsonb string checks: no jsonb columns discovered in ${record}`)
    return 1
  }
  const migrations = join(record, 'migrations')
  const migrationSql = readdirSync(migrations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(migrations, entry.name, 'migration.sql'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')
  const missing = missingJsonbStringChecks(schemas, migrationSql)
  const validationFailures = jsonbStringValidationFailures(schemas, migrationSql)
  if (missing.length === 0 && validationFailures.length === 0) {
    console.log(`record jsonb string checks: ${columns.length} columns guarded`)
    return 0
  }
  if (missing.length > 0) {
    console.error(
      'record jsonb string checks: every hosted jsonb column needs its named NOT VALID string-refusing CHECK',
    )
    for (const column of missing) console.error(`- ${column}`)
  }
  if (validationFailures.length > 0) {
    console.error('record jsonb string checks: VALIDATE statements violate the validation policy')
    for (const failure of validationFailures) console.error(`- ${failure}`)
  }
  return 1
}

if (import.meta.main) process.exit(run())
