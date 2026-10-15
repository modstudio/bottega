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

const CONVERTED_TABLES = [
  'agent',
  'blocker',
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

export const IDENTITY_BASELINE = [
  'board_claim',
  'board_hosted_adoption_ledger',
  'board_hosted_adoption_receipt',
  'board_message',
  'board_message_tag',
  'board_reach_delivery',
  'board_reach_recording_failure',
  'board_receipt',
  'project',
] as const

const IDENTITY_COLUMNS: Readonly<Record<string, string>> = { subject: 'id' }

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
