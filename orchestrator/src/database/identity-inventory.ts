// concern: orchestrator-identity-inventory
/** Classifies every migrated orchestrator table by progress toward owned UUID identity. */
import type { Database } from 'bun:sqlite'

export type IdentityTable = { name: string; hasRequiredIdentity: boolean }
export type IdentityExemption = { table: string; reason: string }
export type IdentityInventory = {
  converted: string[]
  exempt: string[]
  baseline: string[]
}

export type KeyStore = 'orchestrator' | 'hub' | 'hosted'
export type KeyColumn = {
  table: string
  name: string
  type: string
  primaryKey: boolean
  foreignKey: boolean
}
export type KeyTable = { name: string; columns: KeyColumn[]; primaryKey: string[] }
export type IntegerValue = { store: KeyStore; column: string; reason: string }
export type InfrastructureIdentity = { store: KeyStore; table: string; reason: string }
export type KeyInventory = { findings: string[]; values: string[]; infrastructure: string[] }

const REFERENCE_NAME = /(?:_id|_ids)$/
const IMPLICIT_REFERENCES = new Set(['run.retry_of', 'landing_triage_snapshot.review_ids'])

export function classifyKeyInventory(
  store: KeyStore,
  tables: readonly KeyTable[],
  values: readonly IntegerValue[],
  infrastructure: readonly InfrastructureIdentity[],
): KeyInventory {
  const valueMap = new Map(
    values.filter((entry) => entry.store === store).map((entry) => [entry.column, entry.reason]),
  )
  const infrastructureMap = new Map(
    infrastructure
      .filter((entry) => entry.store === store)
      .map((entry) => [entry.table, entry.reason]),
  )
  const findings: string[] = []
  const seenValues = new Set<string>()
  for (const table of tables) {
    const columns = new Map(table.columns.map((column) => [column.name, column]))
    const primaryColumn = columns.get(table.primaryKey[0]!)
    const uuidPrimaryKey =
      table.primaryKey.length === 1 && isUuidColumn(primaryColumn) && !primaryColumn?.foreignKey
    if (!uuidPrimaryKey) findings.push(`${table.name}:primary-key`)
    for (const column of table.columns) {
      const address = `${table.name}.${column.name}`
      const reference =
        column.foreignKey ||
        (column.type === 'integer' && REFERENCE_NAME.test(column.name)) ||
        (store === 'orchestrator' && IMPLICIT_REFERENCES.has(address))
      if (reference && !isUuidColumn(column)) findings.push(`${address}:reference`)
      if (column.type !== 'integer') continue
      const reason = valueMap.get(address)
      if (reason) {
        if (column.primaryKey || column.foreignKey)
          throw new Error(`${store} integer value ${address} may not be a primary or foreign key`)
        if (reference)
          throw new Error(`${store} integer value ${address} is shaped as a row reference`)
        if (!reason.trim()) throw new Error(`${store} integer value ${address} needs a reason`)
        seenValues.add(address)
      } else if (!column.primaryKey && !reference) {
        throw new Error(
          `${store} integer column ${address} is not classified as a value or row identity`,
        )
      }
    }
  }
  const tableNames = new Set(tables.map((table) => table.name))
  for (const entry of values.filter((candidate) => candidate.store === store)) {
    if (!seenValues.has(entry.column))
      throw new Error(`${store} integer value ${entry.column} is stale`)
  }
  for (const [table, reason] of infrastructureMap) {
    if (!reason.trim()) throw new Error(`${store} infrastructure ${table} needs a reason`)
    if (!tableNames.has(table)) throw new Error(`${store} infrastructure ${table} is stale`)
  }
  return {
    findings: [...new Set(findings)].sort(),
    values: [...seenValues].sort(),
    infrastructure: [...infrastructureMap.keys()].sort(),
  }
}

function isUuidColumn(column: KeyColumn | undefined): boolean {
  return column?.type === 'uuid'
}

export function assertShrinkingKeyBaseline(
  store: KeyStore,
  findings: readonly string[],
  baseline: readonly string[],
): void {
  const actual = new Set(findings)
  const expected = new Set(baseline)
  const added = [...actual].filter((finding) => !expected.has(finding)).sort()
  const stale = [...expected].filter((finding) => !actual.has(finding)).sort()
  if (added.length)
    throw new Error(`${store} identity baseline has new findings: ${added.join(', ')}`)
  if (stale.length)
    throw new Error(
      `${store} identity baseline entries disappeared; remove them: ${stale.join(', ')}`,
    )
}

export function readSqliteKeyTables(database: Database): KeyTable[] {
  const tables = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
  return tables.map(({ name }) => {
    const columns = database
      .query<{ name: string; type: string; pk: number }, []>(`PRAGMA table_info('${name}')`)
      .all()
    const foreignKeys = new Set(
      database
        .query<{ from: string }, []>(`PRAGMA foreign_key_list('${name}')`)
        .all()
        .map((foreignKey) => foreignKey.from),
    )
    return {
      name,
      primaryKey: columns
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name),
      columns: columns.map((column) => ({
        table: name,
        name: column.name,
        type: /INT/i.test(column.type)
          ? 'integer'
          : column.type.toUpperCase() === 'TEXT' &&
              (column.name === 'id' ||
                column.name === 'record_id' ||
                column.name.endsWith('_id') ||
                column.name.endsWith('_record_id'))
            ? 'uuid'
            : column.type.toLowerCase(),
        primaryKey: column.pk > 0,
        foreignKey: foreignKeys.has(column.name),
      })),
    }
  })
}

const CONVERTED_TABLES = [
  'agent',
  'blocker',
  'board_claim',
  'board_hosted_adoption_ledger',
  'board_hosted_adoption_receipt',
  'board_message',
  'board_message_tag',
  'board_reach_delivery',
  'board_reach_recording_failure',
  'board_receipt',
  'branch_landing_record',
  'calibration',
  'canon_pack',
  'canon_eval',
  'check_execution',
  'compared_pair',
  'contention',
  'doc',
  'doc_related_subject',
  'doc_revision',
  'duel',
  'gate_execution',
  'landing',
  'landing_override',
  'landing_review_carry',
  'landing_triage_snapshot',
  'lens',
  'lens_profile',
  'lens_profile_revision',
  'lens_revision',
  'metric',
  'monitor_condition',
  'monitor_invocation',
  'operator_notification',
  'outbox',
  'outbox_quarantine_audit',
  'outbox_redaction_audit',
  'port_baseline',
  'port_doctrine',
  'port_pair',
  'port_ref',
  'port_ref_source',
  'port_skip',
  'project',
  'project_lens_profile',
  'project_lens_profile_revision',
  'probe',
  'question',
  'question_delivery',
  'question_mutation_audit',
  'release_ledger',
  'resource_claim',
  'review',
  'review_finding',
  'review_finding_amendment',
  'review_lens',
  'review_read',
  'run',
  'run_carried_ruling',
  'run_checkpoint',
  'run_mutation_audit',
  'run_message',
  'score',
  'spawn',
  'step_catalogue',
  'step_catalogue_event',
  'step_catalogue_version',
  'test_flake',
  'subject',
  'workflow',
  'workflow_cursor',
  'workflow_event',
  'workflow_obligation',
  'workflow_step_text',
  'workflow_version',
  'worker_note_request',
] as const

export const EXEMPT_TABLES: readonly IdentityExemption[] = [
  { table: 'schema_meta', reason: 'schema metadata keyed by its setting name' },
  { table: 'orch_migrations', reason: 'migration journal maintained by the schema service' },
  { table: 'orch_schema_lock', reason: 'singleton migration coordination row' },
  { table: 'record_install_binding', reason: 'singleton installation binding' },
  { table: 'session_seen', reason: 'replaceable session liveness cache' },
  { table: 'presence', reason: 'replaceable session presence cache' },
  { table: 'board_reach_recording', reason: 'singleton board reach cursor' },
  { table: 'main_stack_activity', reason: 'replaceable per-project activity cache' },
  {
    table: 'hosted_board_message_cache',
    reason: 'copy of a hosted row carrying its hosted identity',
  },
  {
    table: 'hosted_board_message_tag_cache',
    reason: 'copy of a hosted row carrying its hosted identity',
  },
  {
    table: 'hosted_board_receipt_cache',
    reason: 'copy of a hosted row carrying its hosted identity',
  },
]

export const IDENTITY_BASELINE = [] as const

const IDENTITY_COLUMNS: Readonly<Record<string, string>> = {
  board_hosted_adoption_ledger: 'source_record_id',
  board_hosted_adoption_receipt: 'message_record_id',
  subject: 'id',
}

export function decideIdentityInventory(
  tables: readonly IdentityTable[],
  converted: readonly string[] = CONVERTED_TABLES,
  exemptions: readonly IdentityExemption[] = EXEMPT_TABLES,
  baseline: readonly string[] = IDENTITY_BASELINE,
): IdentityInventory {
  const convertedSet = new Set(converted)
  const exemptSet = new Set(exemptions.map((entry) => entry.table))
  const baselineSet = new Set(baseline)
  const classes = [...converted, ...exemptSet, ...baseline]
  if (new Set(classes).size !== classes.length)
    throw new Error('orchestrator identity inventory lists a table in more than one class')
  for (const exemption of exemptions) {
    if (!exemption.reason.trim())
      throw new Error(`orchestrator identity exemption ${exemption.table} needs a stated reason`)
  }
  for (const table of tables) validateIdentityTable(table, convertedSet, exemptSet, baselineSet)
  const actual = new Set(tables.map((table) => table.name))
  for (const named of classes) {
    if (!actual.has(named))
      throw new Error(`orchestrator identity inventory names missing table ${named}`)
  }
  return {
    converted: [...converted].sort(),
    exempt: [...exemptSet].sort(),
    baseline: [...baseline].sort(),
  }
}

function validateIdentityTable(
  table: IdentityTable,
  converted: ReadonlySet<string>,
  exempt: ReadonlySet<string>,
  baseline: ReadonlySet<string>,
): void {
  if (!converted.has(table.name) && !exempt.has(table.name) && !baseline.has(table.name))
    throw new Error(
      `orchestrator identity inventory does not classify table ${table.name}; ` +
        'add it to CONVERTED_TABLES, EXEMPT_TABLES with a reason, or IDENTITY_BASELINE',
    )
  if (converted.has(table.name) && !table.hasRequiredIdentity)
    throw new Error(`converted table ${table.name} does not have a required UUID identity column`)
  if (baseline.has(table.name) && table.hasRequiredIdentity)
    throw new Error(
      `baseline table ${table.name} now has a required UUID identity; ` +
        'remove it from IDENTITY_BASELINE and add it to CONVERTED_TABLES',
    )
}

function readIdentityTables(database: Database): IdentityTable[] {
  const names = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
  return names.map(({ name }) => {
    const columns = database
      .query<{ name: string; type: string; notnull: number; pk: number }, []>(
        `PRAGMA table_info('${name}')`,
      )
      .all()
    const identityColumn = IDENTITY_COLUMNS[name] ?? 'record_id'
    const hasRequiredIdentity = columns.some(
      (column) =>
        column.type.toUpperCase() === 'TEXT' &&
        (column.notnull === 1 || column.pk === 1) &&
        column.name === identityColumn,
    )
    return { name, hasRequiredIdentity }
  })
}

export function orchestratorIdentityInventory(database: Database): IdentityInventory {
  return decideIdentityInventory(readIdentityTables(database))
}

export function formatIdentityInventory(inventory: IdentityInventory): string {
  const line = (name: keyof IdentityInventory) =>
    `${name} (${inventory[name].length}): ${inventory[name].join(', ')}`
  return [line('converted'), line('exempt'), line('baseline')].join('\n')
}
