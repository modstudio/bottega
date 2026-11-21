// concern: note read authority
/** Selects the canonical note read source and applies filters at its owning boundary. */

import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { formatNoteLabel } from '../../shared/note-label.ts'
import { db } from './db.ts'
import { resolveHostedUrl } from './hosted-url.ts'
import { hostedWriteMode } from './hosted-write-mode.ts'
import { listHostedNoteRows, type NoteFilters, readHostedNote } from './note-hosted-record.ts'
import type { NoteClientOptions } from './note-client.ts'
import { listOutsideProjectNotes } from './note-outside.ts'
import type { NoteRow } from './note-row.ts'
import { projects } from './projects.ts'

function decode(row: Omit<NoteRow, 'anchors' | 'label'> & { anchors: string }): NoteRow {
  return {
    ...row,
    label: formatNoteLabel(row.project, row.number),
    anchors: JSON.parse(row.anchors),
  }
}

const registered = (name: string) => projects().some((project) => project.name === name)

function listLocalNotes(filters: NoteFilters = {}): NoteRow[] {
  const clauses: string[] = []
  const values: (string | number)[] = []
  const sessions = [
    ...new Set(
      (Array.isArray(filters.session) ? filters.session : filters.session ? [filters.session] : [])
        .map((session) => session.trim())
        .filter(Boolean),
    ),
  ]
  if (filters.kept && !sessions.length) throw new Error('listing kept notes requires a session')
  if (filters.project) {
    if (!registered(filters.project)) throw new Error(`unknown project '${filters.project}'`)
    clauses.push('note.project = ?')
    values.push(filters.project)
  }
  if (filters.stale !== undefined)
    clauses.push(filters.stale ? 'note.stale_at IS NOT NULL' : 'note.stale_at IS NULL')
  if (sessions.length) {
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
  if (filters.actionable) clauses.push('note.stale_at IS NULL AND note.promoted_task IS NULL')
  const rows = db()
    .query<Omit<NoteRow, 'anchors' | 'label'> & { anchors: string }, (string | number)[]>(
      `SELECT note.* FROM note ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY note.last_seen_at DESC, note.record_id DESC`,
    )
    .all(...values)
  const search = filters.text?.toLowerCase()
  return (search ? rows.filter((row) => row.text.toLowerCase().includes(search)) : rows).map(decode)
}

export async function listNotes(
  filters: NoteFilters = {},
  hosted?: NoteClientOptions,
): Promise<NoteRow[]> {
  if (filters.project && !registered(filters.project))
    throw new Error(`unknown project '${filters.project}'`)
  if (hostedWriteMode(hosted?.baseUrl ?? resolveHostedUrl()) === 'hosted-configured')
    return listHostedNoteRows(filters, hosted)
  return listLocalNotes(filters)
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
  if (filters.project && !registered(filters.project)) {
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
  return decode(row)
}
