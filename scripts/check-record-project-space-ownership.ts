import type { Transaction } from '@electric-sql/pglite'
import {
  NON_OWNING_PROJECT_REFERENCES,
  type ProjectSpaceOwnership,
  RECORD_PROJECT_SPACE_OWNERSHIP,
} from './record-project-space-ownership.ts'

const failure = (message: string): never => {
  throw new Error(`DEV-1214 ${message}`)
}

function assertSpaceTables(spaceTables: string[]): void {
  const declared = RECORD_PROJECT_SPACE_OWNERSHIP.map((entry) => entry.table).sort()
  if (new Set(declared).size !== declared.length)
    failure('project-space ownership declaration contains duplicate tables')
  if (JSON.stringify(spaceTables) !== JSON.stringify(declared))
    failure(
      `project-space ownership declaration mismatch: catalogue=${JSON.stringify(spaceTables)} declaration=${JSON.stringify(declared)}`,
    )
}

function assertEntryColumns(entry: ProjectSpaceOwnership, columns: Set<string>): void {
  if (entry.kind === 'project') {
    for (const column of entry.ownerColumns)
      if (!columns.has(`${entry.table}.${column}`))
        failure(`project-space owner column is missing: ${entry.table}.${column}`)
    return
  }
  if (entry.kind !== 'parent') return
  for (const parent of entry.parents) {
    if (!columns.has(`${entry.table}.${parent.column}`))
      failure(`project-space parent column is missing: ${entry.table}.${parent.column}`)
    if (!columns.has(`${parent.table}.id`))
      failure(`project-space parent table is missing an id: ${parent.table}`)
  }
}

function declaredProjectReferences(columns: Set<string>): string[] {
  const references: string[] = []
  for (const entry of RECORD_PROJECT_SPACE_OWNERSHIP) {
    assertEntryColumns(entry, columns)
    if (entry.kind !== 'project') continue
    for (const column of entry.ownerColumns)
      if (column === 'project_id' || column === 'target_project_id')
        references.push(`${entry.table}.${column}`)
  }
  for (const reference of NON_OWNING_PROJECT_REFERENCES) {
    const name = `${reference.table}.${reference.column}`
    if (!columns.has(name)) failure(`non-owning project reference is missing: ${name}`)
    references.push(name)
  }
  return references.sort()
}

type ClassificationRow = readonly [table: string, kind: string]
type OwnershipRow = readonly [
  table: string,
  ownerColumn: string | null,
  parentTable: string | null,
  parentColumn: string | null,
]

function valuesBody(definition: string, table: string): string {
  const match = definition.match(
    new RegExp(`INSERT\\s+INTO\\s+${table}\\s*\\([^;]+?\\)\\s*VALUES([\\s\\S]*?);`, 'i'),
  )
  if (!match?.[1]) failure(`project move function ${table} VALUES declaration is missing`)
  return match[1]
}

function sqlString(value: string): string {
  return value.replaceAll("''", "'")
}

function extractClassificationRows(definition: string): ClassificationRow[] {
  const body = valuesBody(definition, 'project_space_classification')
  const rows = [...body.matchAll(/\(\s*'((?:''|[^'])*)'\s*,\s*'((?:''|[^'])*)'\s*\)/g)].map(
    (match) => [sqlString(match[1]!), sqlString(match[2]!)] as const,
  )
  if (rows.length !== (body.match(/\(/g) ?? []).length)
    failure('project move function classification VALUES rows could not be parsed exactly')
  return rows
}

function nullableSqlValue(value: string | undefined, literal: string | undefined): string | null {
  return value?.toUpperCase() === 'NULL' ? null : sqlString(literal!)
}

function extractOwnershipRows(definition: string): OwnershipRow[] {
  const body = valuesBody(definition, 'project_ownership')
  const value = `(NULL|'((?:''|[^'])*)')`
  const rowPattern = new RegExp(
    `\\(\\s*'((?:''|[^'])*)'\\s*,\\s*${value}\\s*,\\s*${value}\\s*,\\s*${value}\\s*,\\s*'((?:''|[^'])*)'\\s*\\)`,
    'g',
  )
  const rows = [...body.matchAll(rowPattern)].map(
    (match) =>
      [
        sqlString(match[1]!),
        nullableSqlValue(match[2], match[3]),
        nullableSqlValue(match[4], match[5]),
        nullableSqlValue(match[6], match[7]),
      ] as const,
  )
  if (rows.length !== (body.match(/\(/g) ?? []).length)
    failure('project move function ownership VALUES rows could not be parsed exactly')
  return rows
}

function expectedClassificationRows(): ClassificationRow[] {
  return RECORD_PROJECT_SPACE_OWNERSHIP.map((entry) => [entry.table, entry.kind] as const)
}

function expectedOwnershipRows(): OwnershipRow[] {
  const rows: OwnershipRow[] = []
  for (const entry of RECORD_PROJECT_SPACE_OWNERSHIP) {
    if (entry.kind === 'project')
      for (const column of entry.ownerColumns) rows.push([entry.table, column, null, null])
    if (entry.kind === 'parent')
      for (const parent of entry.parents)
        rows.push([entry.table, null, parent.table, parent.column])
  }
  return rows
}

function rowKey(row: readonly (string | null)[]): string {
  return JSON.stringify(row)
}

function assertExactRows(
  label: string,
  actualRows: readonly (readonly (string | null)[])[],
  expectedRows: readonly (readonly (string | null)[])[],
): void {
  const actual = new Set(actualRows.map(rowKey))
  const expected = new Set(expectedRows.map(rowKey))
  if (actual.size !== actualRows.length)
    failure(`project move function ${label} has duplicate rows`)
  const missing = [...expected].filter((row) => !actual.has(row))
  const unexpected = [...actual].filter((row) => !expected.has(row))
  if (missing.length || unexpected.length)
    failure(
      `project move function ${label} mismatch: missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`,
    )
}

export function assertProjectSpaceFunctionDeclaration(definition: string): void {
  assertExactRows(
    'classification',
    extractClassificationRows(definition),
    expectedClassificationRows(),
  )
  assertExactRows('ownership', extractOwnershipRows(definition), expectedOwnershipRows())
}

export async function proofProjectSpaceOwnershipDeclaration(
  transaction: Transaction,
): Promise<void> {
  const started = performance.now()
  const spaceTables = (
    await transaction.query<{ table_name: string }>(`
      SELECT DISTINCT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='space_id' ORDER BY table_name
    `)
  ).rows.map((row) => row.table_name)
  assertSpaceTables(spaceTables)
  const columns = new Set(
    (
      await transaction.query<{ table_name: string; column_name: string }>(`
        SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'
      `)
    ).rows.map((row) => `${row.table_name}.${row.column_name}`),
  )
  const projectReferences = [
    ...new Set(
      (
        await transaction.query<{ table_name: string; column_name: string }>(`
      SELECT child.relname table_name,a.attname column_name
      FROM pg_constraint con
      JOIN pg_class child ON child.oid=con.conrelid
      JOIN pg_class parent ON parent.oid=con.confrelid AND parent.relname='project'
      JOIN LATERAL unnest(con.conkey) key(attnum) ON true
      JOIN pg_attribute a ON a.attrelid=child.oid AND a.attnum=key.attnum
      WHERE con.contype='f' AND a.attname<>'space_id'
    `)
      ).rows.map((row) => `${row.table_name}.${row.column_name}`),
    ),
  ].sort()
  const declaredReferences = declaredProjectReferences(columns)
  if (JSON.stringify(projectReferences) !== JSON.stringify(declaredReferences))
    failure(
      `project references mismatch: catalogue=${JSON.stringify(projectReferences)} declaration=${JSON.stringify(declaredReferences)}`,
    )
  const definition = (
    await transaction.query<{ definition: string }>(`
      SELECT pg_get_functiondef('record_move_project_space(text,text,text,bigint)'::regprocedure) definition
    `)
  ).rows[0]?.definition
  if (!definition) failure('project move function is missing')
  assertProjectSpaceFunctionDeclaration(definition)
  console.log(
    `record project-space ownership gate: ${spaceTables.length} tables in ${(performance.now() - started).toFixed(1)}ms`,
  )
}
