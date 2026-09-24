import type { Database } from 'bun:sqlite'
import { db, writeTransaction } from './db.ts'
import type { HostedAcknowledgement, HostedNote } from './hosted-notes.ts'
import { hostedNoteChanges, type NoteClientOptions } from './note-client.ts'
import { taskRecordIdFor } from './task-identity.ts'

const CURSOR_KEY = 'collect.hosted-notes.cursor'
export function applyHostedNote(conn: Database, row: HostedNote) {
  if (row.deleted_at) {
    conn.query('DELETE FROM note WHERE id=?').run(row.number)
    return
  }
  const promotedTaskRecordId = row.promoted_task
    ? taskRecordIdFor(conn, row.promoted_task, row.project)
    : null
  conn
    .query(`INSERT INTO note(record_id,id,project,text,area,anchors,sightings,created_at,last_seen_at,stale_at,stale_reason,promoted_task,promoted_task_record_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET record_id=excluded.record_id,
    project=excluded.project,text=excluded.text,area=excluded.area,anchors=excluded.anchors,
    sightings=excluded.sightings,created_at=excluded.created_at,last_seen_at=excluded.last_seen_at,
    stale_at=excluded.stale_at,stale_reason=excluded.stale_reason,promoted_task=excluded.promoted_task,
    promoted_task_record_id=excluded.promoted_task_record_id`)
    .run(
      row.id,
      row.number,
      row.project,
      row.text,
      row.area,
      row.anchors,
      row.sightings,
      row.created_at,
      row.last_seen_at,
      row.stale_at,
      row.stale_reason,
      row.promoted_task,
      promotedTaskRecordId,
    )
}
export function applyHostedAcknowledgement(conn: Database, row: HostedAcknowledgement) {
  const note = conn
    .query<{ id: number }, [string]>('SELECT id FROM note WHERE record_id=?')
    .get(row.note_id)
  if (row.deleted_at) {
    conn.query('DELETE FROM note_acknowledgement WHERE record_id=?').run(row.id)
    return
  }
  if (!note) return
  conn
    .query(`INSERT INTO note_acknowledgement(record_id,note_id,session_id,acknowledged_at,sightings)
    VALUES (?,?,?,?,?) ON CONFLICT(note_id,session_id) DO UPDATE SET record_id=excluded.record_id,
    acknowledged_at=excluded.acknowledged_at,sightings=excluded.sightings`)
    .run(row.id, note.id, row.session_id, row.acknowledged_at, row.sightings)
}
export function applyHostedNoteChanges(changes: Awaited<ReturnType<typeof hostedNoteChanges>>) {
  writeTransaction((conn) => {
    changes.notes.forEach((row) => {
      applyHostedNote(conn, row)
    })
    changes.acknowledgements.forEach((row) => {
      applyHostedAcknowledgement(conn, row)
    })
    conn
      .query(
        `INSERT INTO setting(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(CURSOR_KEY, changes.cursor)
  })
}
export async function pullHostedNotes(options: NoteClientOptions = {}) {
  const cursor =
    db().query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?').get(CURSOR_KEY)
      ?.value ?? null
  const changes = await hostedNoteChanges(cursor, options)
  applyHostedNoteChanges(changes)
  return {
    notes: changes.notes.length,
    acknowledgements: changes.acknowledgements.length,
    cursor: changes.cursor,
  }
}
