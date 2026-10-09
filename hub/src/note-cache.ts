import type { Database } from 'bun:sqlite'
import { db, writeTransaction } from './db.ts'
import type { HostedAcknowledgement, HostedNote } from './hosted-notes.ts'
import { persistInstallBinding } from './install-binding.ts'
import { hostedGetNote, hostedNoteChanges, type NoteClientOptions } from './note-client.ts'
import { notePullSpaces } from './note-project-space.ts'
import { projects } from './projects.ts'
import { hostedTaskIdentity } from './task-client.ts'
import { taskRecordIdFor } from './task-identity.ts'

const CURSOR_KEY = 'collect.hosted-notes.cursor'
export function applyHostedNote(conn: Database, row: HostedNote) {
  persistInstallBinding(conn)
  if (row.deleted_at) {
    conn.query('DELETE FROM note WHERE record_id=?').run(row.id)
    return
  }
  const holder = conn
    .query<{ record_id: string }, [string, number]>(
      'SELECT record_id FROM note WHERE project=? AND number=?',
    )
    .get(row.project, row.number)
  if (holder && holder.record_id !== row.id)
    throw new Error(
      `note ${row.project}#${row.number} belongs to UUID ${holder.record_id}, not incoming UUID ${row.id}; run \`hub note list\``,
    )
  const promotedTaskRecordId = row.promoted_task
    ? taskRecordIdFor(conn, row.promoted_task, row.project)
    : null
  conn
    .query(`INSERT INTO note(record_id,number,project,text,area,anchors,sightings,created_at,last_seen_at,stale_at,stale_reason,promoted_task,promoted_task_record_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET
    number=excluded.number,project=excluded.project,text=excluded.text,area=excluded.area,anchors=excluded.anchors,
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
  conn
    .query(`INSERT INTO note_counter(project,next) VALUES (?,?)
      ON CONFLICT(project) DO UPDATE SET next=MAX(note_counter.next,excluded.next)`)
    .run(row.project, row.number + 1)
}
export function applyHostedAcknowledgement(conn: Database, row: HostedAcknowledgement) {
  if (row.deleted_at) {
    conn.query('DELETE FROM note_acknowledgement WHERE record_id=?').run(row.id)
    return
  }
  if (!conn.query('SELECT 1 FROM note WHERE record_id=?').get(row.note_id)) return
  conn
    .query(`INSERT INTO note_acknowledgement(record_id,note_record_id,session_id,acknowledged_at,sightings)
    VALUES (?,?,?,?,?) ON CONFLICT(note_record_id,session_id) DO UPDATE SET record_id=excluded.record_id,
    acknowledged_at=excluded.acknowledged_at,sightings=excluded.sightings`)
    .run(row.id, row.note_id, row.session_id, row.acknowledged_at, row.sightings)
}
export function applyHostedNoteChanges(
  changes: Awaited<ReturnType<typeof hostedNoteChanges>>,
  cursorKey = CURSOR_KEY,
  clearLegacyCursor = false,
) {
  writeTransaction((conn) => {
    changes.notes.forEach((row) => {
      applyHostedNote(conn, row)
    })
    changes.acknowledgements.forEach((row) => {
      applyHostedAcknowledgement(conn, row)
    })
    changes.projectCounters.forEach((counter) => {
      conn
        .query(`INSERT INTO note_counter(project,next) VALUES (?,?)
          ON CONFLICT(project) DO UPDATE SET next=MAX(note_counter.next,excluded.next)`)
        .run(counter.project, counter.next)
    })
    conn
      .query(
        `INSERT INTO setting(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(cursorKey, changes.cursor)
    if (clearLegacyCursor) conn.query('DELETE FROM setting WHERE key=?').run(CURSOR_KEY)
  })
}

function pullCursor(spaceId: string, activeSpaceId: string) {
  const selected = db()
    .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?')
    .get(`${CURSOR_KEY}.${spaceId}`)?.value
  const legacy =
    selected === undefined && spaceId === activeSpaceId
      ? db()
          .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?')
          .get(CURSOR_KEY)?.value
      : undefined
  return { selected, legacy }
}

async function completeAcknowledgementNotes(
  changes: Awaited<ReturnType<typeof hostedNoteChanges>>,
  options: NoteClientOptions,
) {
  const incoming = new Set(changes.notes.map((note) => note.id))
  for (const acknowledgement of changes.acknowledgements) {
    const present =
      incoming.has(acknowledgement.note_id) ||
      Boolean(db().query('SELECT 1 FROM note WHERE record_id=?').get(acknowledgement.note_id))
    if (present) continue
    changes.notes.unshift(await hostedGetNote(acknowledgement.note_id, options))
    incoming.add(acknowledgement.note_id)
  }
}

export async function pullHostedNotes(options: NoteClientOptions = {}) {
  const identity = await hostedTaskIdentity(options)
  const spaces = notePullSpaces(projects(), identity)
  const totals = { notes: 0, acknowledgements: 0, cursor: '' }
  const failures: string[] = []
  for (const spaceId of spaces) {
    const cursorKey = `${CURSOR_KEY}.${spaceId}`
    const { selected, legacy } = pullCursor(spaceId, identity.activeSpaceId)
    try {
      const requestOptions = { ...options, recordSpace: spaceId }
      const changes = await hostedNoteChanges(selected ?? legacy ?? null, requestOptions)
      await completeAcknowledgementNotes(changes, requestOptions)
      applyHostedNoteChanges(changes, cursorKey, legacy !== undefined)
      totals.notes += changes.notes.length
      totals.acknowledgements += changes.acknowledgements.length
      if (spaceId === identity.activeSpaceId) totals.cursor = changes.cursor
    } catch (cause) {
      failures.push(`${spaceId}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  if (failures.length) throw new Error(`hosted note pulls failed: ${failures.join('; ')}`)
  return totals
}
