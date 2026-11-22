// concern: note read authority
/** Owns canonical note reads, source selection, and filter normalization. */

import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { db } from './db.ts'
import type { HostedAcknowledgement } from './hosted-notes.ts'
import { resolveHostedUrl } from './hosted-url.ts'
import { hostedWriteMode } from './hosted-write-mode.ts'
import {
  hostedGetNote,
  hostedListNotes,
  isMissingHostedNote,
  type NoteClientOptions,
} from './note-client.ts'
import { noteRowFromHosted } from './note-hosted-record.ts'
import { listOutsideProjectNotes } from './note-outside.ts'
import { decodeNoteRow, isRegisteredNoteProject, type NoteRow } from './note-row.ts'

export type NoteFilters = {
  project?: string
  stale?: boolean
  session?: string | string[]
  actionable?: boolean
  kept?: boolean
  text?: string
}

type NormalizedNoteFilters = Omit<NoteFilters, 'session'> & { sessions: string[] }

function normalizeNoteFilters(filters: NoteFilters): NormalizedNoteFilters {
  if (filters.project && !isRegisteredNoteProject(filters.project))
    throw new Error(`unknown project '${filters.project}'`)
  const { session, ...rest } = filters
  const sessions = [
    ...new Set(
      (Array.isArray(session) ? session : session ? [session] : [])
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ]
  if (filters.kept && !sessions.length) throw new Error('listing kept notes requires a session')
  return { ...rest, sessions }
}

function appendSessionClauses(
  filters: NormalizedNoteFilters,
  clauses: string[],
  values: (string | number)[],
) {
  const sessions = filters.sessions
  if (!sessions.length) return
  const candidates = sessions.map(() => '?').join(',')
  clauses.push(`EXISTS (
    SELECT 1 FROM json_each(note.anchors)
     WHERE json_extract(value, '$.session_id') IN (${candidates})
  )`)
  values.push(...sessions)
  clauses.push(`${filters.kept ? '' : 'NOT '}EXISTS (
    SELECT 1 FROM note_acknowledgement acknowledgement
     WHERE acknowledgement.note_record_id = note.record_id
       AND acknowledgement.session_id IN (${candidates})
       AND acknowledgement.sightings = note.sightings
  )`)
  values.push(...sessions)
}

function listLocalNotes(filters: NormalizedNoteFilters): NoteRow[] {
  const clauses: string[] = []
  const values: (string | number)[] = []
  if (filters.project) {
    clauses.push('note.project = ?')
    values.push(filters.project)
  }
  if (filters.stale !== undefined)
    clauses.push(filters.stale ? 'note.stale_at IS NOT NULL' : 'note.stale_at IS NULL')
  appendSessionClauses(filters, clauses, values)
  if (filters.actionable) clauses.push('note.stale_at IS NULL AND note.promoted_task IS NULL')
  const rows = db()
    .query<Omit<NoteRow, 'anchors' | 'label'> & { anchors: string }, (string | number)[]>(
      `SELECT note.* FROM note ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY note.last_seen_at DESC, note.record_id DESC`,
    )
    .all(...values)
  const search = filters.text?.toLowerCase()
  return (search ? rows.filter((row) => row.text.toLowerCase().includes(search)) : rows).map(
    decodeNoteRow,
  )
}

const readRemedy = `run \`${PLATFORM_SLUG} record doctor\`, then retry`

function hostedReadFailure(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause)
  return new Error(message.endsWith(readRemedy) ? message : `${message}. ${readRemedy}`)
}

async function readHostedNote(recordId: string, options?: NoteClientOptions): Promise<NoteRow> {
  try {
    return noteRowFromHosted(await hostedGetNote(recordId, options))
  } catch (cause) {
    if (isMissingHostedNote(cause)) throw new Error(`no note ${recordId}`)
    throw hostedReadFailure(cause)
  }
}

function acknowledgementMatches(
  acknowledgement: HostedAcknowledgement,
  note: NoteRow,
  sessions: string[],
) {
  return (
    !acknowledgement.deleted_at &&
    acknowledgement.note_id === note.record_id &&
    sessions.includes(acknowledgement.session_id) &&
    acknowledgement.sightings === note.sightings
  )
}

async function listHostedNoteRows(
  filters: NormalizedNoteFilters,
  options?: NoteClientOptions,
): Promise<NoteRow[]> {
  try {
    const result = await hostedListNotes(
      {
        project: filters.project,
        stale: filters.stale,
        actionable: filters.actionable,
      },
      options,
    )
    const search = filters.text?.toLowerCase()
    return result.notes
      .map(noteRowFromHosted)
      .filter((note) =>
        filters.sessions.length
          ? note.anchors.some((anchor) =>
              filters.sessions.includes(
                typeof anchor.session_id === 'string' ? anchor.session_id : '',
              ),
            ) &&
            filters.kept ===
              result.acknowledgements.some((acknowledgement) =>
                acknowledgementMatches(acknowledgement, note, filters.sessions),
              )
          : true,
      )
      .filter((note) => !search || note.text.toLowerCase().includes(search))
      .sort(
        (left, right) =>
          right.last_seen_at.localeCompare(left.last_seen_at) ||
          right.record_id.localeCompare(left.record_id),
      )
  } catch (cause) {
    throw hostedReadFailure(cause)
  }
}

export async function listNotes(
  filters: NoteFilters = {},
  hosted?: NoteClientOptions,
): Promise<NoteRow[]> {
  const normalized = normalizeNoteFilters(filters)
  if (hostedWriteMode(hosted?.baseUrl ?? resolveHostedUrl()) === 'hosted-configured')
    return listHostedNoteRows(normalized, hosted)
  return listLocalNotes(normalized)
}

export function listActionableNotes(
  filters: { project?: string; session?: string | string[]; text?: string } = {},
  hosted?: NoteClientOptions,
): Promise<NoteRow[]> {
  return listNotes({ ...filters, actionable: true }, hosted)
}

export async function listProjectNotes(
  filters: NoteFilters & { hosted?: NoteClientOptions },
): Promise<NoteRow[]> {
  if (filters.project && !isRegisteredNoteProject(filters.project)) {
    if (filters.stale || filters.kept || filters.actionable)
      throw new Error(
        `outside project '${filters.project}' does not support these note filters; an outside project's notes support only text filtering; drop --stale, --kept and --actionable`,
      )
    const notes = await listOutsideProjectNotes(filters.project, filters.hosted)
    const search = filters.text?.toLowerCase()
    return search ? notes.filter((note) => note.text.toLowerCase().includes(search)) : notes
  }
  if (filters.actionable && filters.kept)
    throw new Error('--actionable and --kept are mutually exclusive')
  if (filters.kept && !filters.session)
    throw new Error(
      `${PLATFORM_SLUG} note list --kept requires --session ID or a session environment`,
    )
  const { hosted, ...localFilters } = filters
  return listNotes(
    { ...localFilters, stale: Boolean(filters.stale), kept: Boolean(filters.kept) },
    hosted,
  )
}

export async function getNote(recordId: string, hosted?: NoteClientOptions): Promise<NoteRow> {
  if (hostedWriteMode(hosted?.baseUrl ?? resolveHostedUrl()) === 'hosted-configured')
    return readHostedNote(recordId, hosted)
  const row = db()
    .query<Omit<NoteRow, 'anchors' | 'label'> & { anchors: string }, [string]>(
      'SELECT * FROM note WHERE record_id = ?',
    )
    .get(recordId)
  if (!row) throw new Error(`no note ${recordId}`)
  return decodeNoteRow(row)
}
