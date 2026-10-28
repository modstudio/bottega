import type { Database } from 'bun:sqlite'
import { writeTransaction } from './db.ts'
import { confirmCount } from './hosted-tasks.ts'
import { hostedReapNotes, type NoteClientOptions } from './note-client.ts'
import type { RegisteredProject } from './projects.ts'
import { hostedTaskIdentity } from './task-client.ts'
import { partitionProjectRows } from './task-project-space.ts'

// This module applies note-staleness decisions to local and hosted stores. It
// must not decide whether an anchor vanished or whether a note was triaged.

export type StalenessChange = {
  recordId: string
  label: string
  project: string
  action: 'annotate' | 'mark' | 'restore'
  reason: string | null
}

export type StalenessResult = {
  marked: number
  annotated: number
  restored: number
  deleted: number
  reasons: { recordId: string; label: string; reason: string }[]
}

type DeletedRow = { record_id: string; project: string }

function applyChange(conn: Database, change: StalenessChange, at: string): void {
  if (change.action === 'mark') {
    conn
      .query('UPDATE note SET stale_at=?,stale_reason=? WHERE record_id=? AND stale_at IS NULL')
      .run(at, change.reason, change.recordId)
    return
  }
  conn
    .query('UPDATE note SET stale_at=NULL,stale_reason=? WHERE record_id=?')
    .run(change.reason, change.recordId)
}

function result(changes: StalenessChange[], deleted: number): StalenessResult {
  return {
    marked: changes.filter((change) => change.action === 'mark').length,
    annotated: changes.filter((change) => change.action === 'annotate').length,
    restored: changes.filter((change) => change.action === 'restore').length,
    deleted,
    reasons: changes.flatMap((change) =>
      change.reason
        ? [{ recordId: change.recordId, label: change.label, reason: change.reason }]
        : [],
    ),
  }
}

export function applyLocalStaleness(
  changes: StalenessChange[],
  deletedIds: string[],
  at: string,
  cutoff: string,
): StalenessResult {
  return writeTransaction((conn) => {
    for (const change of changes) applyChange(conn, change, at)
    const found = deletedIds.flatMap((id) => {
      const row = conn
        .query<{ record_id: string }, [string, string]>(
          `SELECT record_id FROM note WHERE record_id=? AND stale_at IS NOT NULL AND sightings=1
           AND promoted_task IS NULL AND last_seen_at <= ?`,
        )
        .get(id, cutoff)
      return row ? [row.record_id] : []
    })
    if (found.length < deletedIds.length)
      throw new Error('local cache is behind the record; the next maintenance pass will recompute')
    confirmCount(found.length, deletedIds.length, 'bulk-only')
    for (const id of found) conn.query('DELETE FROM note WHERE record_id=?').run(id)
    return result(changes, found.length)
  })
}

export async function applyHostedStaleness(
  changes: StalenessChange[],
  deletedRows: DeletedRow[],
  at: string,
  cutoff: string,
  registered: RegisteredProject[],
  hosted?: NoteClientOptions,
): Promise<StalenessResult> {
  const identity = await hostedTaskIdentity(hosted)
  const maintenance = [
    ...changes.map((row) => ({ kind: row.action, ...row, project_name: row.project })),
    ...deletedRows.map((row) => ({
      kind: 'deleted' as const,
      recordId: row.record_id,
      project_name: row.project,
    })),
  ]
  const partitioned = partitionProjectRows(maintenance, registered, identity)
  const failures = [...partitioned.refusals].map(
    ([project, refusal]) => `${project}: ${refusal.reason}`,
  )
  const totals: StalenessResult = result([], 0)
  for (const [spaceId, rows] of partitioned.destinations) {
    const stale = rows.flatMap((row) => (row.kind === 'mark' && 'reason' in row ? [row] : []))
    const annotated = rows.flatMap((row) =>
      row.kind === 'annotate' && 'reason' in row ? [row] : [],
    )
    const restored = rows.flatMap((row) => (row.kind === 'restore' && 'reason' in row ? [row] : []))
    const removed = rows.filter((row) => row.kind === 'deleted')
    try {
      const response = await hostedReapNotes(
        {
          stale: stale.map((row) => ({ recordId: row.recordId, reason: row.reason ?? '', at })),
          annotated: annotated.map((row) => ({ recordId: row.recordId, reason: row.reason })),
          restored: restored.map((row) => ({ recordId: row.recordId, reason: row.reason })),
          deleted: removed.map((row) => row.recordId),
          confirmation: removed.length,
          cutoff,
        },
        { ...hosted, recordSpace: spaceId },
      )
      writeTransaction((conn) => {
        for (const change of [...stale, ...annotated, ...restored]) applyChange(conn, change, at)
        for (const item of removed)
          conn.query('DELETE FROM note WHERE record_id=?').run(item.recordId)
      })
      totals.marked += response.marked
      totals.annotated += response.annotated
      totals.restored += response.restored
      totals.deleted += response.deleted
    } catch (cause) {
      failures.push(`${spaceId}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  if (failures.length) throw new Error(`hosted note reaps failed: ${failures.join('; ')}`)
  return { ...totals, reasons: result(changes, 0).reasons }
}
