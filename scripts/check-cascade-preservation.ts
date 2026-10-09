import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type Node, type Program, parse } from 'sql-parser-cst'
import {
  MIGRATIONS_FOLDER,
  migrationJournal,
  splitMigrationSource,
  stripSqlComments,
} from '../orchestrator/src/database/migrations.ts'

export type CascadeExemption = {
  migration: string
  deletedTable: string
  dependentTable: string
  remedy: string
}

export type CascadeRisk = {
  migration: string
  deletedTable: string
  dependentTable: string
  detectedBy: ('parse' | 'replay')[]
}

export type CascadeProbe = {
  risks: CascadeRisk[]
  unprobed: { migration: string; table: string; reason: string }[]
}

type Migration = { tag: string; source: string }
type AstNode = Node & Record<string, unknown>
type ForeignKey = { parent: string; dependent: string }

// These migrations may already be applied. The repair restores every
// missing review_finding row from its outbox payload, whichever migration removed it.
const EXEMPTIONS: readonly CascadeExemption[] = [
  {
    migration: '0019_run_close_out_forgotten',
    deletedTable: 'review_lens',
    dependentTable: 'review_finding',
    remedy: 'DEV-852: restore review_finding rows lost by the applied migration from outbox',
  },
  {
    migration: '0041_readonly_clone_source',
    deletedTable: 'review_lens',
    dependentTable: 'review_finding',
    remedy: 'DEV-852: restore review_finding rows lost by the applied migration from outbox',
  },
]

function program(migration: Migration): Program {
  return parse(splitMigrationSource(migration.source).ddl, {
    dialect: 'sqlite',
    filename: `${migration.tag}.sql`,
  })
}

function nodes(node: unknown, type: string): AstNode[] {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((item) => nodes(item, type))
  const current = node as AstNode
  return [
    ...(current.type === type ? [current] : []),
    ...Object.entries(current).flatMap(([key, value]) =>
      key === 'leading' || key === 'trailing' ? [] : nodes(value, type),
    ),
  ]
}

function name(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null
  const value = node as AstNode
  if (value.type === 'identifier') return String(value.name).toLowerCase()
  if (value.type === 'member_expr') return name(value.property)
  if (value.type === 'alias') return name(value.expr)
  return null
}

function statementTables(statement: AstNode, clauseType: string, field: string): string[] {
  return nodes(statement, clauseType).flatMap((clause) => {
    const value = clause[field] as AstNode | undefined
    const items = value?.type === 'list_expr' ? (value.items as unknown[]) : value ? [value] : []
    return items.flatMap((item) => {
      const table = name(item)
      return table ? [table] : []
    })
  })
}

function destructiveTables(statement: AstNode): string[] {
  if (statement.type === 'delete_stmt') return statementTables(statement, 'delete_clause', 'tables')
  if (statement.type === 'drop_table_stmt')
    return statementTables(statement, 'drop_table_stmt', 'tables')
  return []
}

function selectedTable(statement: AstNode): string | null {
  const from = nodes(statement, 'from_clause')[0]
  return from ? name(from.expr) : null
}

function snapshot(statement: AstNode): { snapshot: string; source: string } | null {
  if (statement.type !== 'create_table_stmt') return null
  const table = name(statement.name)
  const source = selectedTable(statement)
  return table && source ? { snapshot: table, source } : null
}

function restore(statement: AstNode): { target: string; snapshot: string } | null {
  if (statement.type !== 'insert_stmt') return null
  const insert = nodes(statement, 'insert_clause')[0]
  const target = insert ? name(insert.table) : null
  const source = selectedTable(statement)
  return target && source ? { target, snapshot: source } : null
}

function parsedForeignKeys(tree: Program): ForeignKey[] {
  const result: ForeignKey[] = []
  for (const statement of tree.statements as AstNode[]) {
    if (statement.type !== 'create_table_stmt') continue
    const dependent = name(statement.name)
    if (!dependent) continue
    for (const reference of nodes(statement, 'references_specification')) {
      const cascades = nodes(reference.options, 'referential_action').some(
        (action) =>
          (action.eventKw as { name?: string } | undefined)?.name === 'DELETE' &&
          (action.actionKw as { name?: string } | undefined)?.name === 'CASCADE',
      )
      const parent = name(reference.table)
      if (cascades && parent) result.push({ parent, dependent })
    }
  }
  return result
}

function isExempt(
  migration: string,
  deletedTable: string,
  dependentTable: string,
  exemptions: readonly CascadeExemption[],
): boolean {
  return exemptions.some(
    (entry) =>
      entry.migration === migration &&
      entry.deletedTable === deletedTable &&
      entry.dependentTable === dependentTable,
  )
}

export function validateCascadeExemptions(exemptions: readonly CascadeExemption[]): void {
  const keys = new Set<string>()
  for (const exemption of exemptions) {
    const key = `${exemption.migration}:${exemption.deletedTable}:${exemption.dependentTable}`
    if (keys.has(key)) throw new Error(`duplicate cascade-preservation exemption: ${key}`)
    keys.add(key)
    if (!/^DEV-\d+:\s+\S/.test(exemption.remedy)) {
      throw new Error(`cascade-preservation exemption ${key} needs a DEV task and remedy`)
    }
  }
}

function parserRisks(
  migration: Migration,
  tree: Program,
  foreignKeys: readonly ForeignKey[],
  exemptions: readonly CascadeExemption[],
): CascadeRisk[] {
  const statements = tree.statements as AstNode[]
  const snapshots = statements.flatMap((statement, index) => {
    const value = snapshot(statement)
    return value ? [{ ...value, index }] : []
  })
  const restores = statements.flatMap((statement, index) => {
    const value = restore(statement)
    return value ? [{ ...value, index }] : []
  })
  const risks: CascadeRisk[] = []
  for (const [index, statement] of statements.entries()) {
    for (const deletedTable of destructiveTables(statement)) {
      for (const { dependent } of foreignKeys.filter((key) => key.parent === deletedTable)) {
        const preserved = snapshots.some(
          (copy) =>
            copy.source === dependent &&
            copy.index < index &&
            restores.some(
              (write) =>
                write.target === dependent &&
                write.snapshot === copy.snapshot &&
                write.index > index,
            ),
        )
        if (!preserved && !isExempt(migration.tag, deletedTable, dependent, exemptions)) {
          risks.push({
            migration: migration.tag,
            deletedTable,
            dependentTable: dependent,
            detectedBy: ['parse'],
          })
        }
      }
    }
  }
  return risks
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

type TableInfo = {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

type ProbeValue = string | number | Uint8Array | null

function probeValue(column: TableInfo): Exclude<ProbeValue, null> {
  const type = column.type.toUpperCase()
  if (type.includes('INT')) return 1
  if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return 1
  if (type.includes('BLOB')) return new Uint8Array([1])
  return 'probe'
}

function tableSql(database: Database, table: string): string {
  return (
    database.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {
      sql: string
    }
  ).sql
}

function readCheckExpression(
  sql: string,
  start: number,
): { expression: string; end: number } | null {
  let open = start + 5
  while (/\s/.test(sql[open] ?? '')) open++
  if (sql[open] !== '(') return null
  let depth = 1
  let quote: "'" | '"' | null = null
  for (let index = open + 1; index < sql.length; index++) {
    const character = sql[index]
    if (quote && character === quote && sql[index + 1] === quote) index++
    else if (quote && character === quote) quote = null
    else if (!quote && (character === "'" || character === '"')) quote = character
    else if (!quote && character === '(') depth++
    else if (!quote && character === ')' && --depth === 0) {
      return { expression: sql.slice(open + 1, index), end: index }
    }
  }
  return null
}

function checkExpressions(sql: string): string[] {
  const expressions: string[] = []
  for (let start = 0; start < sql.length; start++) {
    if (sql.slice(start, start + 5).toUpperCase() !== 'CHECK') continue
    const check = readCheckExpression(sql, start)
    if (!check) continue
    expressions.push(check.expression)
    start = check.end
  }
  return expressions
}

function mentions(expression: string, column: string): boolean {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^a-zA-Z0-9_])${escaped}(?:$|[^a-zA-Z0-9_])`, 'i').test(expression)
}

function stringLiterals(expression: string): string[] {
  return [...expression.matchAll(/'((?:''|[^'])*)'/g)].map((match) =>
    match[1].replaceAll("''", "'"),
  )
}

function candidates(
  column: TableInfo,
  checks: readonly string[],
  foreign: ProbeValue[],
  ordinal: number,
): ProbeValue[] {
  const related = checks.filter((check) => mentions(check, column.name))
  const type = column.type.toUpperCase()
  const nullable = !column.notnull && !column.pk
  const nullIsNamed = related.some((check) =>
    new RegExp(`${column.name}\\s+IS\\s+NULL`, 'i').test(check),
  )
  const values: ProbeValue[] = nullable && nullIsNamed ? [null, ...foreign] : [...foreign]
  if (nullable && !nullIsNamed) values.push(null)
  if (
    type.includes('INT') ||
    type.includes('REAL') ||
    type.includes('FLOA') ||
    type.includes('DOUB')
  ) {
    const zeroIsNamed = related.some((check) =>
      new RegExp(`(?:${column.name}\\s*=\\s*0|0\\s*=\\s*${column.name})`, 'i').test(check),
    )
    values.push(...(zeroIsNamed ? [0, ordinal, 1, 2, -1] : [ordinal, 1, 2, 0, -1]))
  } else if (type.includes('BLOB')) {
    values.push(new Uint8Array([1]))
  } else {
    values.push(
      ...related.flatMap(stringLiterals),
      `probe-${ordinal}`,
      'probe',
      '[]',
      '{}',
      'a',
      '0',
    )
  }
  return values.filter(
    (value, index, all) =>
      all.findIndex((other) =>
        value instanceof Uint8Array && other instanceof Uint8Array
          ? value.toString() === other.toString()
          : value === other,
      ) === index,
  )
}

function combinations<T>(lists: readonly T[][], limit = 65_536): T[][] {
  let result: T[][] = [[]]
  for (const list of lists) {
    result = result.flatMap((prefix) => list.map((value) => [...prefix, value])).slice(0, limit)
  }
  return result
}

function satisfies(
  database: Database,
  expression: string,
  columns: readonly TableInfo[],
  values: ReadonlyMap<string, ProbeValue>,
): boolean {
  const projection = columns.map((column) => `? AS ${quoteIdentifier(column.name)}`).join(', ')
  const bindings = columns.map((column) => values.get(column.name) ?? null)
  const result = database
    .query(`SELECT (${expression}) AS satisfied FROM (SELECT ${projection})`)
    .get(...bindings) as { satisfied: number | null }
  return result.satisfied !== 0
}

function constrainedValues(
  database: Database,
  columns: readonly TableInfo[],
  checks: readonly string[],
  choices: ReadonlyMap<string, ProbeValue[]>,
): Map<string, ProbeValue> {
  const values = new Map(
    columns.map((column) => [column.name, choices.get(column.name)?.[0] ?? probeValue(column)]),
  )
  for (let pass = 0; pass < checks.length + 1; pass++) {
    let changed = false
    for (const check of checks) {
      if (satisfies(database, check, columns, values)) continue
      const involved = columns.filter((column) => mentions(check, column.name))
      const solution = combinations(involved.map((column) => choices.get(column.name) ?? [])).find(
        (combination) => {
          const attempt = new Map(values)
          involved.forEach((column, index) => {
            attempt.set(column.name, combination[index])
          })
          return satisfies(database, check, columns, attempt)
        },
      )
      if (!solution) throw new Error(`could not satisfy CHECK (${check.trim()}) mechanically`)
      involved.forEach((column, index) => {
        values.set(column.name, solution[index])
      })
      changed = true
    }
    if (!changed) return values
  }
  const failing = checks.filter((check) => !satisfies(database, check, columns, values))
  const involved = columns.filter((column) => failing.some((check) => mentions(check, column.name)))
  const solution = combinations(
    involved.map((column) => choices.get(column.name) ?? []),
    65_536,
  ).find((combination) => {
    const attempt = new Map(values)
    involved.forEach((column, index) => {
      attempt.set(column.name, combination[index])
    })
    return checks.every((check) => satisfies(database, check, columns, attempt))
  })
  if (!solution) throw new Error('CHECK constraints could not be satisfied together')
  involved.forEach((column, index) => {
    values.set(column.name, solution[index])
  })
  return values
}

function tableNames(database: Database): string[] {
  return (
    database
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((row) => row.name)
}

function foreignKeys(database: Database): ForeignKey[] {
  return tableNames(database).flatMap((dependent) =>
    (
      database.query(`PRAGMA foreign_key_list(${quoteIdentifier(dependent)})`).all() as {
        table: string
        on_delete: string
      }[]
    )
      .filter((key) => key.on_delete.toUpperCase() === 'CASCADE')
      .map((key) => ({ parent: key.table.toLowerCase(), dependent: dependent.toLowerCase() })),
  )
}

function rowCount(database: Database, table: string): number {
  return (
    database.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as {
      count: number
    }
  ).count
}

function probeTargetRows(database: Database, names: readonly string[]): Map<string, number> {
  const targets = new Map(names.map((table) => [table, 1]))
  for (const table of names) {
    const references = database
      .query(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
      .all() as { table: string }[]
    for (const parent of new Set(references.map((key) => key.table))) {
      if (references.filter((key) => key.table === parent).length > 1) targets.set(parent, 2)
    }
  }
  return targets
}

function probeChoices(
  database: Database,
  columns: readonly TableInfo[],
  foreignKeys: readonly { from: string; table: string; to: string }[],
  checks: readonly string[],
  ordinal: number,
): Map<string, ProbeValue[]> {
  return new Map(
    columns.map((column) => {
      const key = foreignKeys.find((candidate) => candidate.from === column.name)
      const foreign = key
        ? (
            database
              .query(
                `SELECT ${quoteIdentifier(key.to)} AS value FROM ${quoteIdentifier(key.table)} ORDER BY ${quoteIdentifier(key.to)} LIMIT 8`,
              )
              .all() as { value: ProbeValue }[]
          ).map((row) => row.value)
        : []
      return [column.name, candidates(column, checks, foreign, ordinal)]
    }),
  )
}

function seedTables(database: Database, migration: string): CascadeProbe['unprobed'] {
  const names = tableNames(database)
  const targetRows = probeTargetRows(database, names)
  const pending = new Set(
    names.filter((table) => rowCount(database, table) < (targetRows.get(table) ?? 1)),
  )
  const failures = new Map<string, string>()
  while (pending.size) {
    let inserted = 0
    for (const table of pending) {
      const existing = rowCount(database, table)
      const columns = database
        .query(`PRAGMA table_info(${quoteIdentifier(table)})`)
        .all() as TableInfo[]
      const foreignKeys = database
        .query(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
        .all() as { from: string; table: string; to: string }[]
      const foreignColumns = new Set(foreignKeys.map((key) => key.from))
      const checks = checkExpressions(tableSql(database, table))
      const required = columns.filter(
        (column) =>
          foreignColumns.has(column.name) ||
          checks.some((check) => mentions(check, column.name)) ||
          (column.dflt_value === null &&
            (column.notnull || (column.pk && !column.type.toUpperCase().includes('INT')))),
      )
      const choices = probeChoices(database, required, foreignKeys, checks, existing + 1)
      const sql = required.length
        ? `INSERT INTO ${quoteIdentifier(table)} (${required.map((column) => quoteIdentifier(column.name)).join(', ')}) VALUES (${required.map(() => '?').join(', ')})`
        : `INSERT INTO ${quoteIdentifier(table)} DEFAULT VALUES`
      try {
        const values = constrainedValues(database, required, checks, choices)
        database.query(sql).run(...required.map((column) => values.get(column.name) ?? null))
        const count = rowCount(database, table)
        if (count >= (targetRows.get(table) ?? 1)) pending.delete(table)
        failures.delete(table)
        inserted++
      } catch (error) {
        failures.set(table, String(error))
      }
    }
    if (!inserted) break
  }
  return [...pending].map((table) => ({
    migration,
    table,
    reason: failures.get(table) ?? 'no insertable probe row',
  }))
}

function counts(database: Database): Map<string, number> {
  return new Map(
    tableNames(database).map((table) => [
      table.toLowerCase(),
      (
        database.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as {
          count: number
        }
      ).count,
    ]),
  )
}

function execute(database: Database, migration: Migration): void {
  const ddl = splitMigrationSource(migration.source).ddl.trim()
  if (stripSqlComments(ddl).trim()) database.exec(ddl)
}

function probeDestructiveMigration(
  database: Database,
  migration: Migration,
  destroyed: ReadonlySet<string>,
  exemptions: readonly CascadeExemption[],
  result: CascadeProbe,
): void {
  result.unprobed.push(...seedTables(database, migration.tag))
  const before = counts(database)
  const relationships = foreignKeys(database)
  execute(database, migration)
  const after = counts(database)
  for (const [table, count] of before) {
    if (destroyed.has(table) || (after.get(table) ?? 0) >= count) continue
    for (const relationship of relationships.filter(
      (key) => key.dependent === table && destroyed.has(key.parent),
    )) {
      if (!isExempt(migration.tag, relationship.parent, table, exemptions)) {
        result.risks.push({
          migration: migration.tag,
          deletedTable: relationship.parent,
          dependentTable: table,
          detectedBy: ['replay'],
        })
      }
    }
  }
  const violations = database.query('PRAGMA foreign_key_check').all() as unknown[]
  if (violations.length) {
    throw new Error(`${migration.tag} left ${violations.length} foreign key violation(s)`)
  }
}

export function probeMigrations(
  migrations: readonly Migration[],
  exemptions: readonly CascadeExemption[] = [],
): CascadeProbe {
  validateCascadeExemptions(exemptions)
  const database = new Database(':memory:')
  database.exec('PRAGMA foreign_keys=ON')
  const result: CascadeProbe = { risks: [], unprobed: [] }
  try {
    for (const migration of migrations) {
      const tree = program(migration)
      const destroyed = new Set(
        (tree.statements as AstNode[]).flatMap((statement) => destructiveTables(statement)),
      )
      if (!destroyed.size) {
        execute(database, migration)
        continue
      }
      probeDestructiveMigration(database, migration, destroyed, exemptions, result)
    }
  } finally {
    database.close()
  }
  return result
}

function nextForeignKeys(relationships: ForeignKey[], tree: Program, migrationKeys: ForeignKey[]) {
  const replacedDependents = new Set(migrationKeys.map((key) => key.dependent))
  for (const statement of tree.statements as AstNode[]) {
    if (statement.type === 'create_table_stmt') {
      const table = name(statement.name)
      if (table) replacedDependents.add(table)
    }
    if (statement.type === 'drop_table_stmt') {
      for (const table of destructiveTables(statement)) replacedDependents.add(table)
    }
  }
  return [
    ...relationships.filter((key) => !replacedDependents.has(key.dependent)),
    ...migrationKeys,
  ]
}

export function cascadeRisks(
  migrations: readonly Migration[],
  exemptions: readonly CascadeExemption[] = [],
): CascadeRisk[] {
  validateCascadeExemptions(exemptions)
  let relationships: ForeignKey[] = []
  const risks: CascadeRisk[] = []
  for (const migration of migrations) {
    const tree = program(migration)
    const migrationKeys = parsedForeignKeys(tree)
    risks.push(...parserRisks(migration, tree, [...relationships, ...migrationKeys], exemptions))
    relationships = nextForeignKeys(relationships, tree, migrationKeys)
  }
  risks.push(...probeMigrations(migrations, exemptions).risks)
  const combined = new Map<string, CascadeRisk>()
  for (const risk of risks) {
    const key = `${risk.migration}:${risk.deletedTable}:${risk.dependentTable}`
    const previous = combined.get(key)
    if (!previous) combined.set(key, { ...risk, detectedBy: [...risk.detectedBy] })
    else {
      for (const source of risk.detectedBy) {
        if (!previous.detectedBy.includes(source)) previous.detectedBy.push(source)
      }
    }
  }
  return [...combined.values()]
}

export function cascadeRefusal(risks: readonly CascadeRisk[]): string {
  return risks
    .map(
      ({ migration, deletedTable, dependentTable, detectedBy }) =>
        `${migration} [${detectedBy.join('+')}] deletes or drops ${deletedTable}, which would cascade-delete ${dependentTable}; ` +
        `add ${dependentTable} to the migration's copy/delete/restore sequence`,
    )
    .join('\n')
}

function checkCascadePreservation(
  folder = MIGRATIONS_FOLDER,
  exemptions: readonly CascadeExemption[] = EXEMPTIONS,
): CascadeProbe {
  const migrations = migrationJournal(folder).map((entry) => ({
    tag: entry.tag,
    source: readFileSync(`${folder}/${entry.tag}.sql`, 'utf8'),
  }))
  const risks = cascadeRisks(migrations, exemptions)
  const probe = probeMigrations(migrations, exemptions)
  return { risks, unprobed: probe.unprobed }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const started = performance.now()
  const result = checkCascadePreservation()
  for (const { migration, table, reason } of result.unprobed) {
    console.warn(`cascade preservation probe: ${migration} could not seed ${table}: ${reason}`)
  }
  console.log(`cascade preservation timing: ${Math.round(performance.now() - started)}ms`)
  if (result.unprobed.length) {
    console.error(
      `cascade preservation check refused: ${result.unprobed.length} table probe(s) were inconclusive`,
    )
    process.exit(1)
  }
  if (result.risks.length) {
    console.error(cascadeRefusal(result.risks))
    process.exit(1)
  }
  console.log('cascade preservation check passed')
}
