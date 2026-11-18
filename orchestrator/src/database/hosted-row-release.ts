// concern: hosted-row-release
/** Verifies hosted workflow history before releasing its local copies after machine update. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal } from '../../../shared/refusal.ts'
import { readRecordInstallBinding } from '../record/install-binding.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import {
  TASK_FLOW_PRESENCE_BATCH_MAX,
  type TaskFlowPresence,
} from '../record/record-task-flow-contract.ts'
import { RefusalError } from '../refusal-error.ts'
import { withSynchronousDatabaseForMigrationStep, writeTransaction } from './db.ts'

export const HOSTED_ROW_RELEASE_SHOWN_IDS = 5

// Children precede parents by foreign key because deletion runs in this order.
export const HOSTED_ROW_TABLES = [
  'workflow_obligation',
  'workflow_step_text',
  'workflow_text_copy',
  'question_mutation_audit',
  'question',
  'workflow_cursor',
  'task_flow',
] as const

type HostedRowTable = (typeof HOSTED_ROW_TABLES)[number]
export type HostedRowIds = Record<HostedRowTable, ReadonlySet<string>>

export type HostedRowReleaseDecision =
  | { kind: 'nothing' }
  | { kind: 'release'; ids: HostedRowIds }
  | { kind: 'refuse'; missing: HostedRowIds }

function emptyIds(ids: HostedRowIds): boolean {
  return HOSTED_ROW_TABLES.every((table) => ids[table].size === 0)
}

/** Decide whether collected local rows are all present on the hosted record. */
export function decideHostedRowRelease(
  local: HostedRowIds,
  present: HostedRowIds,
): HostedRowReleaseDecision {
  if (emptyIds(local)) return { kind: 'nothing' }
  const missing = emptyHostedRowIds()
  for (const table of HOSTED_ROW_TABLES)
    for (const id of local[table]) if (!present[table].has(id)) missing[table].add(id)
  return emptyIds(missing) ? { kind: 'release', ids: local } : { kind: 'refuse', missing }
}

/** Render the bounded per-table detail for a hosted-row release refusal. */
export function hostedRowReleaseMissingDetail(missing: HostedRowIds): string {
  return HOSTED_ROW_TABLES.flatMap((table) => {
    const ids = [...missing[table]]
    if (ids.length === 0) return []
    const shown = ids.slice(0, HOSTED_ROW_RELEASE_SHOWN_IDS)
    const omitted = ids.length - shown.length
    const suffix = omitted > 0 ? `, and ${omitted} more` : ''
    return [`${table}: ${shown.join(', ')}${suffix}`]
  }).join('; ')
}

type Presentation = { log(value: string): void }
type WithDatabase = <T>(action: (database: Database) => T) => T
type PresenceReader = (input: TaskFlowPresence) => Promise<TaskFlowPresence>

export type HostedRowReleaseDependencies = {
  withDatabase?: WithDatabase
  presence?: PresenceReader
}

const PRESENCE_FIELDS = {
  workflow_obligation: 'obligationIds',
  workflow_step_text: 'textIds',
  workflow_text_copy: 'textCopyIds',
  question_mutation_audit: 'questionAuditIds',
  question: 'questionIds',
  workflow_cursor: 'stageIds',
  task_flow: 'flowIds',
} as const satisfies Record<HostedRowTable, keyof TaskFlowPresence>

function idsFromRows(rows: { record_id: string }[]): Set<string> {
  return new Set(rows.map(({ record_id }) => record_id))
}

function collectHostedRowIds(database: Database): HostedRowIds {
  return {
    workflow_obligation: idsFromRows(
      database.query<{ record_id: string }, []>('SELECT record_id FROM workflow_obligation').all(),
    ),
    workflow_step_text: idsFromRows(
      database.query<{ record_id: string }, []>('SELECT record_id FROM workflow_step_text').all(),
    ),
    workflow_text_copy: idsFromRows(
      database.query<{ record_id: string }, []>('SELECT record_id FROM workflow_text_copy').all(),
    ),
    question_mutation_audit: idsFromRows(
      database
        .query<{ record_id: string }, []>('SELECT record_id FROM question_mutation_audit')
        .all(),
    ),
    question: idsFromRows(
      database.query<{ record_id: string }, []>('SELECT record_id FROM question').all(),
    ),
    workflow_cursor: idsFromRows(
      database.query<{ record_id: string }, []>('SELECT record_id FROM workflow_cursor').all(),
    ),
    task_flow: idsFromRows(
      database.query<{ record_id: string }, []>('SELECT record_id FROM task_flow').all(),
    ),
  }
}

function emptyHostedRowIds(): Record<HostedRowTable, Set<string>> {
  return {
    workflow_obligation: new Set(),
    workflow_step_text: new Set(),
    workflow_text_copy: new Set(),
    question_mutation_audit: new Set(),
    question: new Set(),
    workflow_cursor: new Set(),
    task_flow: new Set(),
  }
}

function presenceRequest(local: HostedRowIds, batch: number): TaskFlowPresence {
  const offset = batch * TASK_FLOW_PRESENCE_BATCH_MAX
  const chunk = (table: HostedRowTable) =>
    [...local[table]].slice(offset, offset + TASK_FLOW_PRESENCE_BATCH_MAX)
  return {
    obligationIds: chunk('workflow_obligation'),
    textIds: chunk('workflow_step_text'),
    textCopyIds: chunk('workflow_text_copy'),
    questionAuditIds: chunk('question_mutation_audit'),
    questionIds: chunk('question'),
    stageIds: chunk('workflow_cursor'),
    flowIds: chunk('task_flow'),
  }
}

async function readPresentIds(local: HostedRowIds, read: PresenceReader): Promise<HostedRowIds> {
  const present = emptyHostedRowIds()
  const batches = Math.max(
    ...HOSTED_ROW_TABLES.map((table) =>
      Math.ceil(local[table].size / TASK_FLOW_PRESENCE_BATCH_MAX),
    ),
  )
  for (let batch = 0; batch < batches; batch += 1) {
    const response = await read(presenceRequest(local, batch))
    for (const table of HOSTED_ROW_TABLES)
      for (const id of response[PRESENCE_FIELDS[table]]) present[table].add(id)
  }
  return present
}

function defaultPresenceReader(input: TaskFlowPresence): Promise<TaskFlowPresence> {
  const read = recordApiClient().readTaskFlowPresence
  if (!read) throw new Error('record API predates task-flow presence reads')
  return read(input)
}

function releaseRefusal(condition: string): RefusalError {
  return new RefusalError(
    refusal(condition, { kind: 'command', argv: [PLATFORM_SLUG, 'record', 'sign-in'] }),
  )
}

function deleteHostedRows(database: Database, ids: HostedRowIds): void {
  writeTransaction(() => {
    const obligations = database.query('DELETE FROM workflow_obligation WHERE record_id=?')
    const texts = database.query('DELETE FROM workflow_step_text WHERE record_id=?')
    const copies = database.query('DELETE FROM workflow_text_copy WHERE record_id=?')
    const audits = database.query('DELETE FROM question_mutation_audit WHERE record_id=?')
    const questions = database.query('DELETE FROM question WHERE record_id=?')
    const clearCursorHandoffs = database.query(
      'UPDATE workflow_cursor SET handed_off_from_record_id=NULL WHERE record_id=?',
    )
    const cursors = database.query('DELETE FROM workflow_cursor WHERE record_id=?')
    const flows = database.query('DELETE FROM task_flow WHERE record_id=?')
    for (const id of ids.workflow_obligation) obligations.run(id)
    for (const id of ids.workflow_step_text) texts.run(id)
    for (const id of ids.workflow_text_copy) copies.run(id)
    for (const id of ids.question_mutation_audit) audits.run(id)
    for (const id of ids.question) questions.run(id)
    for (const id of ids.workflow_cursor) clearCursorHandoffs.run(id)
    for (const id of ids.workflow_cursor) cursors.run(id)
    for (const id of ids.task_flow) flows.run(id)
  }, database)
}

/** Release local hosted rows only after the record confirms every collected id is present. */
export async function releaseHostedRowsAfterUpdate(
  presentation: Presentation,
  deps: HostedRowReleaseDependencies = {},
): Promise<void> {
  const withDatabase = deps.withDatabase ?? withSynchronousDatabaseForMigrationStep
  const local = withDatabase((database) =>
    readRecordInstallBinding(database).bound ? collectHostedRowIds(database) : null,
  )
  if (!local) return
  if (emptyIds(local)) return

  let present: HostedRowIds
  try {
    present = await readPresentIds(local, deps.presence ?? defaultPresenceReader)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw releaseRefusal(
      `local workflow history presence could not be verified; nothing was released: ${detail}`,
    )
  }
  const decision = decideHostedRowRelease(local, present)
  if (decision.kind === 'refuse')
    throw releaseRefusal(
      `local workflow history is not all on the record; nothing was released: ${hostedRowReleaseMissingDetail(decision.missing)}`,
    )

  const released = decision as Extract<HostedRowReleaseDecision, { kind: 'release' }>
  withDatabase((database) => deleteHostedRows(database, released.ids))
  const rowCount = HOSTED_ROW_TABLES.reduce((total, table) => total + released.ids[table].size, 0)
  const tableCount = HOSTED_ROW_TABLES.filter((table) => released.ids[table].size > 0).length
  presentation.log(
    `released local workflow history now on the record: ${rowCount} rows across ${tableCount} tables`,
  )
}
