// concern: record-change-feed
/** Reads record changes and materializes each served family with its existing keyset serializer. */
import type { SQL } from 'bun'
import {
  type RecordChangeCursor,
  type RecordChangeEntry,
  type RecordChangeReadPage,
  readRecordChanges,
} from '../../../shared/record/record-changes.ts'
import type { TenantPrincipal } from '../../../shared/record/tenant.ts'
import { recordDocRow } from './record-doc-mapping.ts'
import { recordDocRows } from './record-doc-read.ts'
import { mapRecordLensRow, recordLensRows } from './record-lens-catalogue.ts'
import { RECORD_LENS_TABLES, type RecordLensTable } from './record-lens-contract.ts'
import { recordPool } from './record-pool.ts'
import { mapRecordPortRow, recordPortRows } from './record-port-catalogue.ts'
import { RECORD_PORT_TABLES, type RecordPortTable } from './record-port-contract.ts'
import { mapRecordProjectRow, recordProjectRows } from './record-projects.ts'
import {
  mapRecordRoutingEvidenceRow,
  recordRoutingEvidenceRows,
} from './record-routing-evidence.ts'
import { mapRecordSubjectRow, recordSubjectRows } from './record-subjects.ts'
import { mapRecordScoreRow, recordScoreRows } from './record-verdicts.ts'
import { mapRecordWorkflowRow, recordWorkflowRows } from './record-workflow-catalogue.ts'
import { RECORD_WORKFLOW_TABLES, type RecordWorkflowTable } from './record-workflow-contract.ts'

export const RECORD_CHANGE_SERVED_TABLES = [
  'doc',
  'subject',
  'project',
  ...RECORD_LENS_TABLES,
  ...RECORD_PORT_TABLES,
  ...RECORD_WORKFLOW_TABLES,
  'run_score',
  'routing_evidence',
] as const
type RecordChangeServedTable = (typeof RECORD_CHANGE_SERVED_TABLES)[number]
const RECORD_CHANGE_LOG_TABLES = [
  ...RECORD_CHANGE_SERVED_TABLES.filter((table) => table !== 'routing_evidence'),
  'run',
] as const

type MaterializedRecordChange = {
  table: RecordChangeServedTable
  id: string
  space: string
  op: 'upsert' | 'delete'
  row?: unknown
}
export type RecordChangeFamilyKey = Omit<MaterializedRecordChange, 'row'> & { position: number }
export function familyKeys(changes: readonly RecordChangeEntry[]): RecordChangeFamilyKey[] {
  const keyed = new Map<string, RecordChangeFamilyKey>()
  const keep = (key: RecordChangeFamilyKey) => keyed.set(`${key.table}:${key.id}`, key)
  for (const [position, change] of changes.entries()) {
    if (change.table === 'run') {
      keep({
        table: 'routing_evidence',
        id: change.id,
        space: change.space,
        op: change.op,
        position,
      })
      keep({
        table: 'run_score',
        id: change.id,
        space: change.space,
        op: change.op,
        position,
      })
    } else if (change.table === 'run_score') {
      keep({
        table: 'run_score',
        id: change.id,
        space: change.space,
        op: change.op,
        position,
      })
      keep({
        table: 'routing_evidence',
        id: change.id,
        space: change.space,
        op: 'upsert',
        position,
      })
    } else if ((RECORD_CHANGE_SERVED_TABLES as readonly string[]).includes(change.table))
      keep({
        table: change.table as RecordChangeServedTable,
        id: change.id,
        space: change.space,
        op: change.op,
        position,
      })
  }
  return [...keyed.values()].sort((left, right) => left.position - right.position)
}

async function rowsByFamily(
  tx: SQL,
  keys: readonly RecordChangeFamilyKey[],
): Promise<Map<string, unknown>> {
  const result = new Map<string, unknown>()
  const ids = (table: RecordChangeServedTable) => [
    ...new Set(
      keys.filter((key) => key.table === table && key.op !== 'delete').map((key) => key.id),
    ),
  ]
  const add = (
    table: RecordChangeServedTable,
    rows: Record<string, unknown>[],
    map: (row: Record<string, unknown>) => unknown,
    idColumn = 'id',
  ) => {
    for (const row of rows) result.set(`${table}:${String(row[idColumn])}`, map(row))
  }
  const docs = ids('doc')
  if (docs.length) add('doc', await recordDocRows(tx, { ids: docs }), recordDocRow)
  const projects = ids('project')
  if (projects.length) add('project', await recordProjectRows(tx, projects), mapRecordProjectRow)
  const subjects = ids('subject')
  if (subjects.length)
    add('subject', await recordSubjectRows(tx, { ids: subjects }), mapRecordSubjectRow)
  for (const table of RECORD_LENS_TABLES) {
    const rowIds = ids(table)
    if (rowIds.length)
      add(table, await recordLensRows(tx, table as RecordLensTable, { ids: rowIds }), (row) =>
        mapRecordLensRow(table as RecordLensTable, row),
      )
  }
  for (const table of RECORD_PORT_TABLES) {
    const rowIds = ids(table)
    if (rowIds.length)
      add(table, await recordPortRows(tx, table as RecordPortTable, { ids: rowIds }), (row) =>
        mapRecordPortRow(table as RecordPortTable, row),
      )
  }
  for (const table of RECORD_WORKFLOW_TABLES) {
    const rowIds = ids(table)
    if (rowIds.length)
      add(
        table,
        await recordWorkflowRows(tx, table as RecordWorkflowTable, { ids: rowIds }),
        (row) => mapRecordWorkflowRow(table as RecordWorkflowTable, row),
      )
  }
  const scores = ids('run_score')
  if (scores.length)
    add('run_score', await recordScoreRows(tx, { ids: scores }), mapRecordScoreRow, 'run_id')
  const evidence = ids('routing_evidence')
  if (evidence.length)
    add(
      'routing_evidence',
      await recordRoutingEvidenceRows(tx, { ids: evidence }),
      (row) => {
        const { evidenceSequence: _cursor, ...item } = mapRecordRoutingEvidenceRow(row)
        return item
      },
    )
  return result
}

export async function materializeRecordChangePage(
  tx: SQL,
  page: Exclude<RecordChangeReadPage, { resetRequired: true }>,
) {
  const keys = familyKeys(page.changes)
  const materialized = await rowsByFamily(tx, keys)
  const changes: MaterializedRecordChange[] = []
  for (const key of keys) {
    const row = materialized.get(`${key.table}:${key.id}`)
    const base = {
      table: key.table,
      id: key.id,
      space: key.space,
      op: row ? ('upsert' as const) : ('delete' as const),
    }
    changes.push(row === undefined ? base : { ...base, row })
  }
  return { ...page, changes }
}

export async function readRecordChangeFeed(
  input: { url: string } & TenantPrincipal & { after: RecordChangeCursor | null; limit: number },
) {
  return readRecordChanges(
    recordPool(input.url),
    input,
    input.after,
    input.limit,
    RECORD_CHANGE_LOG_TABLES,
    async (tx, page) => {
      if (page.resetRequired) return page
      return materializeRecordChangePage(tx, page)
    },
  )
}

export type RecordChangeFeedResult = Awaited<ReturnType<typeof readRecordChangeFeed>>
