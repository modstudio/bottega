#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export type JsonbColumn = { table: string; column: string }

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

export function jsonbColumns(sourceText: string, file = 'schema.ts'): JsonbColumn[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true)
  const columns: JsonbColumn[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const table = node.arguments[0]
      const shape = node.arguments[1]
      if (
        (ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text === 'withRLS'
          : ts.isIdentifier(node.expression) && node.expression.text === 'pgTable') &&
        table &&
        ts.isStringLiteral(table) &&
        shape &&
        ts.isObjectLiteralExpression(shape)
      ) {
        for (const property of shape.properties) {
          if (!ts.isPropertyAssignment(property)) continue
          const jsonb = callNamed(property.initializer, 'jsonb')
          if (!jsonb) continue
          const fallback = propertyName(property)
          const declared = jsonb.arguments[0]
          const column = declared && ts.isStringLiteral(declared) ? declared.text : fallback
          if (column) columns.push({ table: table.text, column })
        }
      }
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
      const expression = `jsonb_typeof(\"${column.column}\") <> 'string'`
      return !migrationSql.includes(`CONSTRAINT \"${name}\" CHECK (${expression}) NOT VALID`)
    })
    .map((column) => `${column.table}.${column.column}`)
    .sort()
}

function run(): number {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const record = join(root, 'shared', 'record')
  const schemas = readdirSync(record)
    .filter((file) => /^schema(?:-[^.]+)?\.ts$/.test(file))
    .map((file) => ({ file, source: readFileSync(join(record, file), 'utf8') }))
  const migrations = join(record, 'migrations')
  const migrationSql = readdirSync(migrations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(migrations, entry.name, 'migration.sql'))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')
  const missing = missingJsonbStringChecks(schemas, migrationSql)
  if (missing.length === 0) {
    console.log(
      `record jsonb string checks: ${schemas.flatMap(({ file, source }) => jsonbColumns(source, file)).length} columns guarded`,
    )
    return 0
  }
  console.error(
    'record jsonb string checks: every hosted jsonb column needs its named NOT VALID string-refusing CHECK',
  )
  for (const column of missing) console.error(`- ${column}`)
  return 1
}

if (import.meta.main) process.exit(run())
