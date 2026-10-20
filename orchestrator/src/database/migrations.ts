import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { readInstallAsset } from '../../../shared/embedded-assets.ts'
import { assetPath } from '../../../shared/install-root.ts'
export const MIGRATIONS_FOLDER = assetPath('orchestrator', 'migrations')
const MIGRATIONS_TABLE = 'orch_migrations'
export const SCHEMA_LOCK_TABLE = 'orch_schema_lock'
const SCHEMA_INVARIANT = "Only the main checkout's binary migrates the store."
export const CONNECTION_SCHEMA_INVARIANT = 'A process writes only the schema version it opened.'
export const JOURNAL_WHEN_ORDER = 'migration journal when values must be strictly increasing'
const BACKFILL_UNCLOSED = 'migration backfill blocks must be closed by -- /BACKFILL'
const RUN_UUID_KEY_MIGRATION = '0124_run_uuid_key'
const LENS_PORT_UUID_KEY_MIGRATION = '0131_lens_port_uuid_key'

type JournalEntry = { idx: number; when: number; tag: string }
export type BeforeMigrationApply = {
  migration: string
  action(database: Database): void
}
type ColumnShape = {
  table: string
  name: string
  type: string
  notnull: number
  defaultValue: string | null
  primaryKey: number
}
type ForeignKeyShape = {
  table: string
  id: number
  sequence: number
  targetTable: string
  from: string
  to: string | null
  onUpdate: string
  onDelete: string
  match: string
}
type IndexShape = {
  table: string
  name: string
  unique: number
  origin: string
  partial: number
  columns: string
  indexSql: string | null
}
type ViewShape = { name: string; sql: string | null }
type TriggerShape = { name: string; table: string; sql: string | null }
type SchemaInventory = {
  tables: string[]
  columns: ColumnShape[]
  foreignKeys: ForeignKeyShape[]
  indexes: IndexShape[]
  checks: { table: string; expression: string }[]
  views: ViewShape[]
  triggers: TriggerShape[]
}

export function migrationJournal(folder = MIGRATIONS_FOLDER): JournalEntry[] {
  const journal = JSON.parse(
    readInstallAsset(
      join('orchestrator', 'migrations', 'meta', '_journal.json'),
      join(folder, 'meta', '_journal.json'),
    ),
  ) as {
    entries: JournalEntry[]
  }
  const entries = journal.entries
  for (let i = 1; i < entries.length; i++) {
    const previous = entries[i - 1]!
    const current = entries[i]!
    if (current.when <= previous.when) {
      throw new Error(
        `refusing to load a migration journal whose when values are not strictly increasing\n` +
          `invariant: ${JOURNAL_WHEN_ORDER}\n` +
          `${previous.tag}@${previous.when} then ${current.tag}@${current.when}`,
      )
    }
  }
  return entries
}

function migrationSource(entry: JournalEntry, folder = MIGRATIONS_FOLDER): string {
  return readInstallAsset(
    join('orchestrator', 'migrations', `${entry.tag}.sql`),
    join(folder, `${entry.tag}.sql`),
  )
}

/** DDL for hashing and one-time apply; backfill blocks are excluded so they can evolve. */
export function splitMigrationSource(source: string): { ddl: string; backfill: string } {
  const opens = source.match(/^[ \t]*--[ \t]*BACKFILL[ \t]*$/gm) ?? []
  const closes = source.match(/^[ \t]*--[ \t]*\/BACKFILL[ \t]*$/gm) ?? []
  if (opens.length !== closes.length) {
    throw new Error(
      `refusing to load a migration whose backfill block is not closed\n` +
        `invariant: ${BACKFILL_UNCLOSED}`,
    )
  }
  const blocks: string[] = []
  const ddl = source.replace(
    /^[ \t]*--[ \t]*BACKFILL[ \t]*\r?\n([\s\S]*?)^[ \t]*--[ \t]*\/BACKFILL[ \t]*\r?\n?/gm,
    (_match, body: string) => {
      blocks.push(body)
      return ''
    },
  )
  return { ddl, backfill: blocks.join('\n') }
}

function migrationHash(entry: JournalEntry, folder = MIGRATIONS_FOLDER): string {
  return createHash('sha256')
    .update(splitMigrationSource(migrationSource(entry, folder)).ddl)
    .digest('hex')
}

export function readUserVersion(d: Database): number {
  return (d.query('PRAGMA user_version').get() as { user_version: number }).user_version
}

function stampUserVersion(d: Database, version: number): void {
  if (!Number.isInteger(version) || version < 0) throw new Error(`invalid user_version ${version}`)
  d.exec(`PRAGMA user_version = ${version}`)
}

export function schemaVersionLabel(d: Database): string {
  const version = readUserVersion(d)
  if (version === 0) return 'unstamped'
  return String(version)
}

export function staleWriteRefusal(actual: number, opened: number, clearedBy: string): string {
  return (
    `refusing to write: the store schema is newer than this process (user_version ${actual}, opened ${opened})\n` +
    `invariant: ${CONNECTION_SCHEMA_INVARIANT}\ncleared by: ${clearedBy}`
  )
}

function tableExists(d: Database, table: string): boolean {
  return !!d.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
}

function migrationState(
  d: Database,
  folder = MIGRATIONS_FOLDER,
): { pending: JournalEntry[]; ahead: string | null } {
  const journal = migrationJournal(folder)
  if (!tableExists(d, MIGRATIONS_TABLE)) return { pending: journal, ahead: null }
  const applied = d
    .query(`SELECT hash, created_at, version FROM ${MIGRATIONS_TABLE} ORDER BY created_at`)
    .all() as { hash: string; created_at: number; version: string | null }[]
  const expected = new Map(journal.map((entry) => [entry.when, migrationHash(entry, folder)]))
  const ahead = applied.find((row) => expected.get(Number(row.created_at)) !== row.hash)
  return {
    pending: journal.filter(
      (entry) =>
        !applied.some(
          (row) => Number(row.created_at) === entry.when && row.hash === expected.get(entry.when),
        ),
    ),
    ahead: ahead
      ? (ahead.version ?? String(ahead.created_at))
      : applied.length > journal.length
        ? (applied.at(-1)?.version ?? String(applied.at(-1)?.created_at))
        : null,
  }
}

export function storeMigrationState(
  d: Database,
  folder = MIGRATIONS_FOLDER,
): 'current' | 'behind' | 'ahead' {
  const state = migrationState(d, folder)
  if (state.ahead) return 'ahead'
  if (state.pending.length) return 'behind'
  return 'current'
}

/** Whether one exact journal entry is already recorded in this store. */
export function migrationApplied(d: Database, tag: string, folder = MIGRATIONS_FOLDER): boolean {
  if (!tableExists(d, MIGRATIONS_TABLE)) return false
  const entry = migrationJournal(folder).find((candidate) => candidate.tag === tag)
  if (!entry) throw new Error(`unknown migration ${tag}`)
  return Boolean(
    d
      .query(`SELECT 1 FROM ${MIGRATIONS_TABLE} WHERE created_at=? AND hash=?`)
      .get(entry.when, migrationHash(entry, folder)),
  )
}

export function migrationRefusal(d: Database): string | null {
  const state = migrationState(d)
  if (state.ahead) {
    return (
      `refusing to open a store ahead of this binary's migration journal: ${state.ahead}\n` +
      `invariant: ${SCHEMA_INVARIANT}\ncleared by: ${PLATFORM_SLUG} machine migrate`
    )
  }
  if (state.pending.length) {
    return (
      `refusing to open a store behind this binary's migration journal: ${state.pending[0]!.tag}\n` +
      `invariant: ${SCHEMA_INVARIANT}\ncleared by: ${PLATFORM_SLUG} machine migrate`
    )
  }
  return null
}

/** Match trunk's schemaVersion canonicalisation: identifier quotes and whitespace are immaterial. */
function normalizeSql(source: string): string {
  return source
    .replace(
      /"([A-Za-z_][A-Za-z0-9_]*)"|`([A-Za-z_][A-Za-z0-9_]*)`|\[([A-Za-z_][A-Za-z0-9_]*)\]/g,
      (
        _match,
        quoted: string | undefined,
        backticked: string | undefined,
        bracketed: string | undefined,
      ) => quoted ?? backticked ?? bracketed ?? '',
    )
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Strip SQL comments outside string literals. A regex strip corrupts a quoted
 * '--' or '/*', and the stripped text is what reaches exec, so the walk has to
 * know where strings are. Single-quoted literals with '' escapes are the only
 * string form these journals use.
 */
export function stripSqlComments(source: string): string {
  let result = ''
  let inString = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (inString) {
      result += char
      if (char === "'") {
        if (source[i + 1] === "'") result += source[++i]!
        else inString = false
      }
      continue
    }
    if (char === "'") {
      inString = true
      result += char
      continue
    }
    if (char === '-' && source[i + 1] === '-') {
      const end = source.indexOf('\n', i)
      if (end === -1) break
      i = end - 1
      continue
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) break
      i = end + 1
      continue
    }
    result += char
  }
  return result
}

function withoutSqlComments(source: string): string {
  return stripSqlComments(source)
}

/** Ignore SQL case and whitespace outside string literals, whose values remain case-sensitive. */
function normalizeExpression(source: string): string {
  let result = ''
  let inString = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (char === "'") {
      result += char
      if (inString && source[i + 1] === "'") result += source[++i]!
      else inString = !inString
    } else if (inString) result += char
    else if (!/\s/.test(char)) result += char.toLowerCase()
  }
  return result
}

function checkExpressions(source: string): string[] {
  const sql = withoutSqlComments(source)
  const expressions: string[] = []
  const check = /\bcheck\s*\(/gi
  for (let match = check.exec(sql); match; match = check.exec(sql)) {
    const start = check.lastIndex
    let depth = 1
    let inString = false
    let end = start
    for (; end < sql.length && depth > 0; end++) {
      const char = sql[end]!
      if (char === "'") {
        if (inString && sql[end + 1] === "'") end++
        else inString = !inString
      } else if (!inString && char === '(') depth++
      else if (!inString && char === ')') depth--
    }
    if (depth !== 0)
      throw new Error(
        `unterminated CHECK expression: ${source.slice(match.index, match.index + 80)}`,
      )
    expressions.push(normalizeExpression(sql.slice(start, end - 1)))
    check.lastIndex = end
  }
  return expressions.sort()
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function schemaInventory(d: Database): SchemaInventory {
  const tableRows = d
    .query(
      `SELECT name, sql FROM sqlite_master
     WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN (?, ?)
     ORDER BY name`,
    )
    .all(MIGRATIONS_TABLE, SCHEMA_LOCK_TABLE) as { name: string; sql: string }[]
  const tables = tableRows.map((row) => row.name).sort()
  const columns: ColumnShape[] = []
  const foreignKeys: ForeignKeyShape[] = []
  const indexes: IndexShape[] = []
  const checks: { table: string; expression: string }[] = []
  for (const table of tableRows) {
    const rows = d.query(`PRAGMA table_info(${quoteIdentifier(table.name)})`).all() as {
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }[]
    for (const row of rows) {
      columns.push({
        table: table.name,
        name: row.name,
        type: normalizeSql(row.type).toLowerCase(),
        notnull: row.notnull,
        defaultValue: row.dflt_value == null ? null : normalizeExpression(row.dflt_value),
        primaryKey: row.pk,
      })
    }
    columns.sort((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name))
    const fks = d.query(`PRAGMA foreign_key_list(${quoteIdentifier(table.name)})`).all() as {
      id: number
      seq: number
      table: string
      from: string
      to: string | null
      on_update: string
      on_delete: string
      match: string
    }[]
    foreignKeys.push(
      ...fks.map((row) => ({
        table: table.name,
        id: row.id,
        sequence: row.seq,
        targetTable: row.table,
        from: row.from,
        to: row.to,
        onUpdate: row.on_update.toLowerCase(),
        onDelete: row.on_delete.toLowerCase(),
        match: row.match.toLowerCase(),
      })),
    )
    const listed = d.query(`PRAGMA index_list(${quoteIdentifier(table.name)})`).all() as {
      name: string
      unique: number
      origin: string
      partial: number
    }[]
    for (const index of listed) {
      const info = d.query(`PRAGMA index_info(${quoteIdentifier(index.name)})`).all() as {
        seqno: number
        cid: number
        name: string | null
      }[]
      // sqlite_autoindex rows have no SQL. Every explicit index does: include
      // it even when index_info names ordinary columns, because direction and
      // collation are not present in that PRAGMA.
      const sql =
        (
          d
            .query("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
            .get(index.name) as { sql: string | null } | null
        )?.sql ?? null
      indexes.push({
        table: table.name,
        name: index.name,
        unique: index.unique,
        origin: index.origin.toLowerCase(),
        partial: index.partial,
        columns: info
          .sort((a, b) => a.seqno - b.seqno)
          .map((row) => `${row.cid}:${row.name ?? '<expression>'}`)
          .join(','),
        indexSql: sql == null ? null : normalizeExpression(normalizeSql(withoutSqlComments(sql))),
      })
    }
    for (const expression of checkExpressions(table.sql))
      checks.push({ table: table.name, expression })
  }
  const views = (
    d
      .query(
        `SELECT name, sql FROM sqlite_master WHERE type='view' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string; sql: string | null }[]
  ).map((row) => ({
    name: row.name,
    sql: row.sql == null ? null : normalizeExpression(normalizeSql(withoutSqlComments(row.sql))),
  }))
  const triggers = (
    d
      .query(
        `SELECT name, tbl_name, sql FROM sqlite_master
     WHERE type='trigger' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string; tbl_name: string; sql: string | null }[]
  ).map((row) => ({
    name: row.name,
    table: row.tbl_name,
    sql: row.sql == null ? null : normalizeExpression(normalizeSql(withoutSqlComments(row.sql))),
  }))
  foreignKeys.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  indexes.sort((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name))
  checks.sort((a, b) => a.table.localeCompare(b.table) || a.expression.localeCompare(b.expression))
  return { tables, columns, foreignKeys, indexes, checks, views, triggers }
}

function inventoryLines(inventory: SchemaInventory): string[] {
  return [
    ...inventory.tables.map((table) => `table ${table}`),
    ...inventory.columns.map(
      (row) =>
        `column ${row.table}.${row.name} ${row.type} notnull=${row.notnull} default=${row.defaultValue ?? 'NULL'} pk=${row.primaryKey}`,
    ),
    ...inventory.foreignKeys.map((row) => `foreign-key ${JSON.stringify(row)}`),
    ...inventory.indexes.map((row) => `index ${JSON.stringify(row)}`),
    ...inventory.checks.map((row) => `check ${row.table} ${row.expression}`),
    ...inventory.views.map((row) => `view ${row.name} ${row.sql ?? 'NULL'}`),
    ...inventory.triggers.map((row) => `trigger ${row.table}.${row.name} ${row.sql ?? 'NULL'}`),
  ]
}

export function canonicalSchemaHash(d: Database): string {
  return createHash('sha256')
    .update(inventoryLines(schemaInventory(d)).join('\n'))
    .digest('hex')
}

function executeStatements(d: Database, source: string): void {
  for (const statement of source.split('--> statement-breakpoint')) {
    const executable = stripSqlComments(statement).trim()
    if (executable) d.exec(executable)
  }
}

function executeMigrationSource(d: Database, source: string): void {
  executeStatements(d, splitMigrationSource(source).ddl)
}

const INTEGER_RUN_REFERENCES = [
  ['run', 'retry_of'],
  ['run', 'parent_run_id'],
  ['blocker', 'run_id'],
  ['board_claim', 'run_id'],
  ['board_message', 'author_run_id'],
  ['calibration', 'run_id'],
  ['canon_eval', 'run_id'],
  ['compared_pair', 'run_a_id'],
  ['compared_pair', 'run_b_id'],
  ['contention', 'run_id'],
  ['duel', 'winner_run_id'],
  ['duel', 'loser_run_id'],
  ['gate_execution', 'run_id'],
  ['question', 'run_id'],
  ['question_delivery', 'run_id'],
  ['resource_claim', 'root_run_id'],
  ['resource_claim', 'run_id'],
  ['review_lens', 'run_id'],
  ['run_carried_ruling', 'run_id'],
  ['run_checkpoint', 'run_id'],
  ['run_message', 'root_run_id'],
  ['run_message', 'run_id'],
  ['run_mutation_audit', 'run_id'],
  ['run_mutation_audit', 'root_id'],
  ['run_mutation_audit', 'turn_id'],
  ['score', 'run_id'],
  ['worker_note_request', 'run_id'],
] as const

const INTEGER_QUESTION_REFERENCES = [
  ['question_delivery', 'question_id'],
  ['question_mutation_audit', 'question_id'],
  ['run_carried_ruling', 'question_id'],
] as const

const REVIEW_LANDING_REFERENCES = [
  ['review_lens', 'review_id', 'review', 'review_record_id'],
  ['review_finding', 'review_id', 'review', 'review_record_id'],
  ['review_finding', 'review_lens_id', 'review_lens', 'review_lens_record_id'],
  ['landing_review_carry', 'review_id', 'review', 'review_record_id'],
  ['landing', 'causing_landing_id', 'landing', 'causing_landing_record_id'],
  ['landing_triage_snapshot', 'override_id', 'landing_override', 'override_record_id'],
  ['landing_triage_snapshot', 'read_id', 'review_read', 'read_record_id'],
  ['contention', 'landing_id', 'landing', 'landing_record_id'],
] as const

const BOARD_REFERENCES = [
  ['board_claim', 'superseded_by_claim_id', 'board_claim', 'superseded_by_claim_record_id'],
  ['board_message', 'thread_root_id', 'board_message', 'thread_root_record_id'],
  ['board_message', 'accepted_reply_id', 'board_message', 'accepted_reply_record_id'],
  ['board_message', 'claim_id', 'board_claim', 'claim_record_id'],
  ['board_message_tag', 'message_id', 'board_message', 'message_record_id'],
  ['board_receipt', 'message_id', 'board_message', 'message_record_id'],
] as const

function runReferenceOrphanCounts(d: Database): string[] {
  const findings: string[] = []
  for (const [table, column] of INTEGER_RUN_REFERENCES) {
    const count = (
      d
        .query(
          `SELECT COUNT(*) AS n FROM ${quoteIdentifier(table)} child
           WHERE child.${quoteIdentifier(column)} IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM run parent WHERE parent.id=child.${quoteIdentifier(column)})`,
        )
        .get() as { n: number }
    ).n
    if (count > 0) findings.push(`${table}.${column}=${count}`)
  }
  return findings
}

function questionReferenceOrphanCounts(d: Database): string[] {
  const findings: string[] = []
  for (const [table, column] of INTEGER_QUESTION_REFERENCES) {
    const count = (
      d
        .query(
          `SELECT COUNT(*) AS n FROM ${quoteIdentifier(table)} child
           WHERE NOT EXISTS (SELECT 1 FROM question parent WHERE parent.id=child.${quoteIdentifier(column)})`,
        )
        .get() as { n: number }
    ).n
    if (count > 0) findings.push(`${table}.${column}=${count}`)
  }
  const notificationCount = (
    d
      .query(
        `SELECT COUNT(*) AS n FROM operator_notification child
         WHERE child.kind='question'
           AND NOT EXISTS (SELECT 1 FROM question parent WHERE parent.id=child.item_id)`,
      )
      .get() as { n: number }
  ).n
  if (notificationCount > 0) findings.push(`operator_notification.item_id=${notificationCount}`)
  return findings
}

function reviewLandingReferenceOrphanCounts(d: Database): string[] {
  const findings: string[] = []
  for (const [table, column, parent, migratedColumn] of REVIEW_LANDING_REFERENCES) {
    const count = (
      d
        .query(
          `SELECT COUNT(*) AS n FROM ${quoteIdentifier(table)} child
           WHERE child.${quoteIdentifier(column)} IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM ${quoteIdentifier(parent)} parent
               WHERE parent.id=child.${quoteIdentifier(column)})`,
        )
        .get() as { n: number }
    ).n
    if (count > 0) findings.push(`${table}.${migratedColumn}=${count}`)
  }
  const amendmentFindingCount = (
    d
      .query(
        `SELECT COUNT(*) AS n FROM review_finding_amendment child
         WHERE NOT EXISTS (
           SELECT 1 FROM review_finding finding
           WHERE finding.review_id=child.review_id AND finding.ordinal=child.finding_ordinal
         )`,
      )
      .get() as { n: number }
  ).n
  if (amendmentFindingCount > 0)
    findings.push(`review_finding_amendment.review_finding_record_id=${amendmentFindingCount}`)
  const jsonCount = (
    d
      .query(
        `SELECT COUNT(*) AS n FROM landing_triage_snapshot snapshot, json_each(snapshot.review_ids) item
         WHERE item.type <> 'integer'
            OR NOT EXISTS (SELECT 1 FROM review WHERE review.id=item.value)`,
      )
      .get() as { n: number }
  ).n
  if (jsonCount > 0) findings.push(`landing_triage_snapshot.review_record_ids=${jsonCount}`)
  return findings
}

function boardReferenceOrphanCounts(d: Database): string[] {
  const findings: string[] = []
  for (const [table, column, parent, migratedColumn] of BOARD_REFERENCES) {
    const count = (
      d
        .query(
          `SELECT COUNT(*) AS n FROM ${quoteIdentifier(table)} child
           WHERE child.${quoteIdentifier(column)} IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM ${quoteIdentifier(parent)} parent
               WHERE parent.id=child.${quoteIdentifier(column)})`,
        )
        .get() as { n: number }
    ).n
    if (count > 0) findings.push(`${table}.${migratedColumn}=${count}`)
  }
  const reachCount = (
    d
      .query(
        `SELECT COUNT(*) AS n FROM board_reach_delivery child
         WHERE child.message_source='local'
           AND NOT EXISTS (SELECT 1 FROM board_message parent
             WHERE parent.id=CAST(child.message_id AS INTEGER))`,
      )
      .get() as { n: number }
  ).n
  if (reachCount > 0) findings.push(`board_reach_delivery.message_record_id=${reachCount}`)
  return findings
}

function docReferenceOrphanCounts(d: Database): string[] {
  const findings: string[] = []
  for (const [table, column, label] of [
    ['doc', 'parent_id', 'doc.parent_record_id'],
    ['doc_revision', 'parent_id', 'doc_revision.parent_record_id'],
  ] as const) {
    const count = (
      d
        .query(
          `SELECT COUNT(*) n FROM ${table} child WHERE child.${column} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM doc parent WHERE parent.id=child.${column})`,
        )
        .get() as { n: number }
    ).n
    if (count) findings.push(`${label}=${count}`)
  }
  const runCount = (
    d
      .query(
        `SELECT COUNT(*) n FROM run row,json_each(row.doc_revisions) item WHERE row.doc_revisions IS NOT NULL AND (item.type<>'integer' OR NOT EXISTS (SELECT 1 FROM doc_revision revision WHERE revision.id=item.value))`,
      )
      .get() as { n: number }
  ).n
  if (runCount) findings.push(`run.doc_revisions=${runCount}`)
  const packCount = (
    d
      .query(
        `SELECT COUNT(*) n FROM canon_pack row,json_each(row.doc_revisions) item WHERE json_type(item.value)<>'object' OR json_type(item.value,'$.revisionId')<>'integer' OR NOT EXISTS (SELECT 1 FROM doc_revision revision WHERE revision.id=json_extract(item.value,'$.revisionId'))`,
      )
      .get() as { n: number }
  ).n
  if (packCount) findings.push(`canon_pack.doc_revisions=${packCount}`)
  const filingCount = (
    d
      .query(
        `SELECT COUNT(*) n FROM question row WHERE row.filed_as='doc' AND (row.filed_ref IS NULL OR instr(row.filed_ref,'@')=0 OR NOT EXISTS (SELECT 1 FROM doc_revision revision WHERE revision.record_id=substr(row.filed_ref,instr(row.filed_ref,'@')+1)))`,
      )
      .get() as { n: number }
  ).n
  if (filingCount) findings.push(`question.filed_ref=${filingCount}`)
  const ambiguousArtifactCount = (
    d
      .query(
        `SELECT COUNT(*) n FROM workflow_obligation row,json_each(row.satisfied_evidence) item JOIN doc document ON document.id=CAST(json_extract(item.value,'$.value') AS INTEGER) JOIN run parent ON parent.number=CAST(json_extract(item.value,'$.value') AS INTEGER) WHERE row.satisfied_evidence IS NOT NULL AND json_extract(item.value,'$.flag')='--artifact' AND json_extract(item.value,'$.value') NOT LIKE 'doc:%'`,
      )
      .get() as { n: number }
  ).n
  if (ambiguousArtifactCount)
    findings.push(`workflow_obligation.satisfied_evidence.ambiguous=${ambiguousArtifactCount}`)
  const artifactCount = (
    d
      .query(
        `SELECT COUNT(*) n FROM workflow_obligation row,json_each(row.satisfied_evidence) item WHERE row.satisfied_evidence IS NOT NULL AND json_extract(item.value,'$.flag')='--artifact' AND NOT EXISTS (SELECT 1 FROM doc document WHERE document.id=CAST(CASE WHEN json_extract(item.value,'$.value') LIKE 'doc:%' THEN substr(json_extract(item.value,'$.value'),5) ELSE json_extract(item.value,'$.value') END AS INTEGER)) AND NOT EXISTS (SELECT 1 FROM doc_revision revision WHERE revision.doc_id=CAST(CASE WHEN json_extract(item.value,'$.value') LIKE 'doc:%' THEN substr(json_extract(item.value,'$.value'),5) ELSE json_extract(item.value,'$.value') END AS INTEGER)) AND ((json_extract(item.value,'$.value') GLOB 'doc:[0-9]*' AND substr(json_extract(item.value,'$.value'),5) NOT GLOB '*[^0-9]*') OR (json_extract(item.value,'$.value') GLOB '[0-9]*' AND json_extract(item.value,'$.value') NOT GLOB '*[^0-9]*' AND NOT EXISTS (SELECT 1 FROM run parent WHERE parent.number=CAST(json_extract(item.value,'$.value') AS INTEGER))))`,
      )
      .get() as { n: number }
  ).n
  if (artifactCount) findings.push(`workflow_obligation.satisfied_evidence=${artifactCount}`)
  return findings
}

function lensPortReferenceOrphanCounts(d: Database): string[] {
  const checks = [
    [
      'lens_revision.lens_record_id',
      `SELECT COUNT(*) n FROM lens_revision r WHERE NOT EXISTS (SELECT 1 FROM lens l WHERE l.id=r.lens_id AND l.space_id IS r.space_id)`,
    ],
    [
      'lens_profile.lens_record_id',
      `SELECT COUNT(*) n FROM lens_profile p WHERE NOT EXISTS (SELECT 1 FROM lens l WHERE l.id=p.lens_id AND l.space_id IS p.space_id)`,
    ],
    [
      'lens_profile_revision.profile_record_id',
      `SELECT COUNT(*) n FROM lens_profile_revision r WHERE NOT EXISTS (SELECT 1 FROM lens_profile p WHERE p.id=r.profile_id)`,
    ],
    [
      'project_lens_profile.lens_record_id',
      `SELECT COUNT(*) n FROM project_lens_profile s WHERE s.lens_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lens l WHERE l.id=s.lens_id AND l.space_id IS s.space_id)`,
    ],
    [
      'project_lens_profile_revision.selection_record_id',
      `SELECT COUNT(*) n FROM project_lens_profile_revision r WHERE NOT EXISTS (SELECT 1 FROM project_lens_profile s WHERE s.id=r.selection_id)`,
    ],
    [
      'port_baseline.pair_record_id',
      `SELECT COUNT(*) n FROM port_baseline b WHERE NOT EXISTS (SELECT 1 FROM port_pair p WHERE p.id=b.pair_id)`,
    ],
    [
      'port_skip.pair_record_id',
      `SELECT COUNT(*) n FROM port_skip s WHERE NOT EXISTS (SELECT 1 FROM port_pair p WHERE p.id=s.pair_id)`,
    ],
    [
      'port_ref_source.ref_record_id',
      `SELECT COUNT(*) n FROM port_ref_source s WHERE NOT EXISTS (SELECT 1 FROM port_ref r WHERE r.target_project_record_id=s.target_project_record_id AND r.task_key=s.task_key AND r.space_id IS s.space_id)`,
    ],
  ] as const
  return checks.flatMap(([label, sql]) => {
    const count = (d.query(sql).get() as { n: number }).n
    return count ? [`${label}=${count}`] : []
  })
}

function portStaleCopyConflicts(d: Database): string[] {
  const bound = Boolean(d.query('SELECT 1 FROM record_install_binding WHERE id=1').get())
  if (!bound) return []
  const checks = [
    [
      'port_pair',
      `l.source_project_record_id=h.source_project_record_id AND l.target_project_record_id=h.target_project_record_id AND l.created_at=h.created_at`,
    ],
    [
      'port_baseline',
      `l.source_commit IS h.source_commit AND (l.scanned_at IS h.scanned_at OR (length(l.scanned_at)=10 AND l.scanned_at||'T00:00:00.000Z'=h.scanned_at)) AND l.version=h.version`,
    ],
    [
      'port_doctrine',
      `l.number=h.number AND l.title=h.title AND l.body=h.body AND l.created_at=h.created_at AND l.retired_at IS h.retired_at AND l.version=h.version`,
    ],
    [
      'port_ref',
      `l.task_key=h.task_key AND l.target_project_record_id=h.target_project_record_id AND l.note=h.note AND l.created_at=h.created_at AND l.resolved_at IS h.resolved_at AND l.version=h.version`,
    ],
    [
      'port_ref_source',
      `l.task_key=h.task_key AND l.target_project_record_id=h.target_project_record_id AND l.source_project_record_id=h.source_project_record_id AND l.commits=h.commits AND l.paths=h.paths AND l.note=h.note`,
    ],
    [
      'port_skip',
      `l.candidate=h.candidate AND l.reason=h.reason AND l.skipped_at=h.skipped_at AND EXISTS (SELECT 1 FROM port_pair lp JOIN port_pair hp ON hp.record_id=lp.record_id AND hp.space_id IS NOT NULL WHERE lp.id=l.pair_id AND hp.id=h.pair_id)`,
    ],
  ] as const
  const conflicts: string[] = []
  for (const [table, equal] of checks) {
    const rows = d
      .query<{ record_id: string }, []>(
        `SELECT l.record_id FROM ${table} l WHERE l.space_id IS NULL AND NOT EXISTS (SELECT 1 FROM ${table} h WHERE h.space_id IS NOT NULL AND h.record_id=l.record_id AND ${equal}) ORDER BY l.record_id`,
      )
      .all()
    conflicts.push(...rows.map((row) => `${table}:${row.record_id}`))
  }
  return conflicts
}

function applyBackfills(d: Database, entries: JournalEntry[], folder: string): void {
  for (const entry of entries) {
    const backfill = splitMigrationSource(migrationSource(entry, folder)).backfill
    if (backfill.trim()) executeStatements(d, backfill)
  }
}

const BACKFILL_SCHEMA_BOUNDARIES = new Set(['0117_project_uuid_key'])
const INTEGER_PROJECT_BACKFILLS = new Set([
  '0006_project_id_backfill',
  '0010_landing_queue',
  '0116_release_project_identity',
])

function compatibleBackfillEntries(d: Database, entries: JournalEntry[]): JournalEntry[] {
  const projectHasIntegerId = (
    d.query("SELECT COUNT(*) AS n FROM pragma_table_info('project') WHERE name='id'").get() as {
      n: number
    }
  ).n
  if (projectHasIntegerId > 0)
    return entries.filter((entry) => !BACKFILL_SCHEMA_BOUNDARIES.has(entry.tag))
  const runHasIntegerId = (
    d.query("SELECT COUNT(*) AS n FROM pragma_table_info('run') WHERE name='id'").get() as {
      n: number
    }
  ).n
  const reviewHasIntegerId = (
    d.query("SELECT COUNT(*) AS n FROM pragma_table_info('review') WHERE name='id'").get() as {
      n: number
    }
  ).n
  return entries.filter(
    (entry) =>
      !INTEGER_PROJECT_BACKFILLS.has(entry.tag) &&
      (runHasIntegerId > 0 || entry.tag !== '0117_project_uuid_key') &&
      (reviewHasIntegerId > 0 || entry.tag !== '0124_run_uuid_key'),
  )
}

const expectedSchemaHashes = new Map<string, string>()

/** Hash the schema produced by the complete journal, not only its adoption baseline. */
export function expectedSchemaHash(folder = MIGRATIONS_FOLDER): string {
  const cached = expectedSchemaHashes.get(folder)
  if (cached) return cached
  const d = new Database(':memory:')
  try {
    d.exec('PRAGMA foreign_keys = ON')
    applyMigrations(d, folder)
    const hash = canonicalSchemaHash(d)
    expectedSchemaHashes.set(folder, hash)
    return hash
  } finally {
    d.close()
  }
}

function shape(values: string[]): string[] {
  return [...values].sort()
}

function inventoryDiff(actual: SchemaInventory, expected: SchemaInventory): string {
  const actualTables = shape(actual.tables)
  const expectedTables = shape(expected.tables)
  const columnKey = (row: ColumnShape) =>
    `${row.table}.${row.name} ${row.type} notnull=${row.notnull} default=${row.defaultValue ?? 'NULL'} pk=${row.primaryKey}`
  const actualColumns = shape(actual.columns.map(columnKey))
  const expectedColumns = shape(expected.columns.map(columnKey))
  const indexKey = (row: IndexShape) => `${row.table}.${row.name} ${JSON.stringify(row)}`
  const actualIndexes = shape(actual.indexes.map(indexKey))
  const expectedIndexes = shape(expected.indexes.map(indexKey))
  const checkKey = (row: { table: string; expression: string }) =>
    `check ${row.table} ${row.expression}`
  const actualChecks = shape(actual.checks.map(checkKey))
  const expectedChecks = shape(expected.checks.map(checkKey))
  const foreignKeyKey = (row: ForeignKeyShape) => `foreign-key ${JSON.stringify(row)}`
  const actualForeignKeys = shape(actual.foreignKeys.map(foreignKeyKey))
  const expectedForeignKeys = shape(expected.foreignKeys.map(foreignKeyKey))
  const viewKey = (row: ViewShape) => `view ${row.name} ${row.sql ?? 'NULL'}`
  const actualViews = shape(actual.views.map(viewKey))
  const expectedViews = shape(expected.views.map(viewKey))
  const triggerKey = (row: TriggerShape) => `trigger ${row.table}.${row.name} ${row.sql ?? 'NULL'}`
  const actualTriggers = shape(actual.triggers.map(triggerKey))
  const expectedTriggers = shape(expected.triggers.map(triggerKey))
  const difference = (left: string[], right: string[]) =>
    left.filter((value) => !right.includes(value))
  return [
    `missing tables: ${difference(expectedTables, actualTables).join(', ') || 'none'}`,
    `unexpected tables: ${difference(actualTables, expectedTables).join(', ') || 'none'}`,
    `missing columns: ${difference(expectedColumns, actualColumns).join(', ') || 'none'}`,
    `unexpected columns: ${difference(actualColumns, expectedColumns).join(', ') || 'none'}`,
    `missing indexes: ${difference(expectedIndexes, actualIndexes).join(', ') || 'none'}`,
    `unexpected indexes: ${difference(actualIndexes, expectedIndexes).join(', ') || 'none'}`,
    `missing checks: ${difference(expectedChecks, actualChecks).join(', ') || 'none'}`,
    `unexpected checks: ${difference(actualChecks, expectedChecks).join(', ') || 'none'}`,
    `missing foreign-keys: ${difference(expectedForeignKeys, actualForeignKeys).join(', ') || 'none'}`,
    `unexpected foreign-keys: ${difference(actualForeignKeys, expectedForeignKeys).join(', ') || 'none'}`,
    `missing views: ${difference(expectedViews, actualViews).join(', ') || 'none'}`,
    `unexpected views: ${difference(actualViews, expectedViews).join(', ') || 'none'}`,
    `missing triggers: ${difference(expectedTriggers, actualTriggers).join(', ') || 'none'}`,
    `unexpected triggers: ${difference(actualTriggers, expectedTriggers).join(', ') || 'none'}`,
  ].join('\n')
}

function baselineInventory(folder = MIGRATIONS_FOLDER): SchemaInventory {
  const baseline = migrationJournal(folder)[0]!
  const d = new Database(':memory:')
  try {
    executeMigrationSource(d, migrationSource(baseline, folder))
    return schemaInventory(d)
  } finally {
    d.close()
  }
}

function createMigrationsTable(d: Database): void {
  d.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT NOT NULL,
    created_at NUMERIC,
    version TEXT
  )`)
}

function ensureSchemaLock(d: Database): void {
  d.exec(`CREATE TABLE IF NOT EXISTS ${SCHEMA_LOCK_TABLE} (
    id INTEGER PRIMARY KEY CHECK (id = 1)
  )`)
  d.exec(`INSERT OR IGNORE INTO ${SCHEMA_LOCK_TABLE} (id) VALUES (1)`)
}

function recordMigration(d: Database, entry: JournalEntry, folder: string): void {
  d.query(`INSERT INTO ${MIGRATIONS_TABLE} (hash,created_at,version) VALUES (?,?,?)`).run(
    migrationHash(entry, folder),
    entry.when,
    entry.tag,
  )
}

function adoptBaseline(d: Database, folder: string): string[] {
  if (tableExists(d, MIGRATIONS_TABLE)) return []
  const applicationObjects = (
    d
      .query(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT IN (?, ?)",
      )
      .get(MIGRATIONS_TABLE, SCHEMA_LOCK_TABLE) as { n: number }
  ).n
  if (applicationObjects === 0) return []
  const actualInventory = schemaInventory(d)
  const expectedInventory = baselineInventory(folder)
  const storedHash = canonicalSchemaHash(d)
  const expectedHash = createHash('sha256')
    .update(inventoryLines(expectedInventory).join('\n'))
    .digest('hex')
  if (storedHash !== expectedHash) {
    throw new Error(
      `refusing to adopt migration baseline: the existing store does not match it\n` +
        `stored hash: ${storedHash}\nexpected hash: ${expectedHash}\n` +
        `${inventoryDiff(actualInventory, expectedInventory)}\n` +
        `back up the store and run the old binary's open once`,
    )
  }
  const entry = migrationJournal(folder)[0]!
  createMigrationsTable(d)
  recordMigration(d, entry, folder)
  stampUserVersion(d, entry.idx + 1)
  return [entry.tag]
}

function migrationOrphanCounts(d: Database, tag: string): string[] {
  if (tag === RUN_UUID_KEY_MIGRATION) return runReferenceOrphanCounts(d)
  if (tag === '0125_question_uuid_key') return questionReferenceOrphanCounts(d)
  if (tag === '0126_review_landing_uuid_key') return reviewLandingReferenceOrphanCounts(d)
  if (tag === '0127_board_uuid_key') return boardReferenceOrphanCounts(d)
  if (tag === '0130_doc_uuid_key') return docReferenceOrphanCounts(d)
  if (tag === LENS_PORT_UUID_KEY_MIGRATION) return lensPortReferenceOrphanCounts(d)
  return []
}

function migrationEntityLabel(tag: string): { migration: string; parent: string } {
  if (tag === RUN_UUID_KEY_MIGRATION) return { migration: 'run', parent: 'run' }
  if (tag === '0125_question_uuid_key') return { migration: 'question', parent: 'question' }
  if (tag === '0126_review_landing_uuid_key')
    return { migration: 'review/landing', parent: 'review/landing row' }
  if (tag === '0130_doc_uuid_key') return { migration: 'document', parent: 'document row' }
  if (tag === LENS_PORT_UUID_KEY_MIGRATION)
    return { migration: 'lens/port catalogue', parent: 'catalogue row' }
  return { migration: 'board', parent: 'board row' }
}

function prepareMigrationEntry(
  d: Database,
  entry: JournalEntry,
  beforeApply?: BeforeMigrationApply,
): void {
  if (beforeApply?.migration === entry.tag) beforeApply.action(d)
  const orphanCounts = migrationOrphanCounts(d, entry.tag)
  if (orphanCounts.length) {
    const label = migrationEntityLabel(entry.tag)
    throw new Error(
      `refusing ${label.migration} UUID-key migration: ` +
        `integer references have no parent ${label.parent} ` +
        `(${orphanCounts.join(', ')})`,
    )
  }
  if (entry.tag === LENS_PORT_UUID_KEY_MIGRATION) {
    const conflicts = portStaleCopyConflicts(d)
    if (conflicts.length) {
      throw new Error(
        `refusing lens/port UUID-key migration: bound store has NULL-space port rows without equivalent hosted twins (${conflicts.join(', ')})\n` +
          `cleared by: reconcile the named rows with the hosted record, then run \`${PLATFORM_SLUG} database migrate\``,
      )
    }
  }
}

function applyMigrationRange(
  d: Database,
  folder: string,
  beforeMigration?: string,
  beforeApply?: BeforeMigrationApply,
): string[] {
  d.exec('PRAGMA busy_timeout = 15000')
  const journal = migrationJournal(folder)
  const boundary = beforeMigration
    ? journal.findIndex((entry) => entry.tag === beforeMigration)
    : journal.length
  if (boundary < 0) throw new Error(`unknown migration boundary ${beforeMigration}`)
  const allowedEntries = journal.slice(0, boundary)
  const legacyAlterTable = (
    d.query('PRAGMA legacy_alter_table').get() as { legacy_alter_table: number }
  ).legacy_alter_table
  d.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = OFF')
  try {
    d.exec('BEGIN IMMEDIATE')
    ensureSchemaLock(d)
    d.exec(`UPDATE ${SCHEMA_LOCK_TABLE} SET id = 1 WHERE id = 1`)
    const versions = adoptBaseline(d, folder)
    const state = migrationState(d, folder)
    if (state.ahead) {
      throw new Error(
        `refusing to migrate a store ahead of this binary's migration journal: ${state.ahead}`,
      )
    }
    const allowed = new Set(allowedEntries.map((entry) => entry.tag))
    for (const entry of state.pending.filter((entry) => allowed.has(entry.tag))) {
      prepareMigrationEntry(d, entry, beforeApply)
      createMigrationsTable(d)
      if (BACKFILL_SCHEMA_BOUNDARIES.has(entry.tag)) {
        const boundary = allowedEntries.findIndex((candidate) => candidate.tag === entry.tag)
        applyBackfills(d, allowedEntries.slice(0, boundary), folder)
      }
      executeMigrationSource(d, migrationSource(entry, folder))
      recordMigration(d, entry, folder)
      stampUserVersion(d, entry.idx + 1)
      versions.push(entry.tag)
    }
    applyBackfills(d, compatibleBackfillEntries(d, allowedEntries), folder)
    const highestApplied = journal.reduce(
      (highest, entry) =>
        state.pending.some((pending) => pending.tag === entry.tag)
          ? highest
          : Math.max(highest, entry.idx + 1),
      0,
    )
    stampUserVersion(d, Math.max(readUserVersion(d), highestApplied))
    const broken = d.query('PRAGMA foreign_key_check').all() as Array<{
      table: string
      rowid: number | null
      parent: string
      fkid: number
    }>
    if (broken.length) {
      const first = broken[0]!
      throw new Error(
        `refusing to commit migration with a dangling foreign key: table ${first.table}, rowid ${first.rowid ?? 'NULL'}, parent ${first.parent}, fkid ${first.fkid}`,
      )
    }
    d.exec('COMMIT')
    return versions
  } catch (error) {
    try {
      d.exec('ROLLBACK')
    } catch {
      /* statement error already aborted the transaction */
    }
    throw error
  } finally {
    d.exec('PRAGMA foreign_keys = ON')
    d.exec(`PRAGMA legacy_alter_table = ${legacyAlterTable}`)
  }
}

/** Apply the complete pending journal and re-run every shipped backfill. */
export function applyMigrations(
  d: Database,
  folder = MIGRATIONS_FOLDER,
  beforeApply?: BeforeMigrationApply,
): string[] {
  return applyMigrationRange(d, folder, undefined, beforeApply)
}

/** Apply pending entries up to, but not including, one named migration. */
export function applyMigrationsBefore(
  d: Database,
  beforeMigration: string,
  folder = MIGRATIONS_FOLDER,
): string[] {
  return applyMigrationRange(d, folder, beforeMigration)
}
