// concern: note read authority
/** Owns canonical note reads, source selection, and filter normalization. */

import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { formatNoteLabel } from '../../shared/note-label.ts'
import { db } from './db.ts'
import type { HostedAcknowledgement } from './hosted-notes.ts'
import { resolveHostedUrl } from './hosted-url.ts'
import { hostedWriteMode } from './hosted-write-mode.ts'
import {
  hostedGetNote,
  hostedListNoteCandidates,
  hostedListNotes,
  hostedListSlimNotes,
  isMissingHostedNote,
  type NoteClientOptions,
} from './note-client.ts'
import { noteRowFromHosted } from './note-hosted-record.ts'
import { listOutsideProjectNotes } from './note-outside.ts'
import { noteReadSpaces } from './note-project-space.ts'
import { decodeNoteRow, isRegisteredNoteProject, type NoteRow } from './note-row.ts'
import { parseSlimNoteReference } from './identity/identity.ts'
import { normalizeSpecialSlimListFilters } from './note-slim-list-filter.ts'
import { noteListLimit, type SlimNote } from './note-slim-list-shape.ts'

export type NoteFilters = {
  project?: string
  stale?: boolean
  session?: string | string[]
  actionable?: boolean
  promotedTo?: string
  reference?: string
  kept?: boolean
  text?: string
}

async function listHostedNoteAcknowledgements(
  options: NoteClientOptions = {},
): Promise<HostedAcknowledgement[]> {
  const spaces = await noteReadSpaces(undefined, options)
  try {
    const results = await Promise.all(
      spaces.map((recordSpace) =>
        hostedListNotes({ stale: true }, { ...options, recordSpace }).catch((cause) => {
          throw spaceReadFailure(recordSpace, undefined, cause)
        }),
      ),
    )
    return results.flatMap(({ acknowledgements }) => acknowledgements)
  } catch (cause) {
    throw hostedReadFailure(cause)
  }
}

export async function listNoteAcknowledgements(
  options: NoteClientOptions = {},
): Promise<{ note_record_id: string; session_id: string }[]> {
  if (hostedWriteMode(options.baseUrl ?? resolveHostedUrl()) === 'hosted-configured')
    return (await listHostedNoteAcknowledgements(options)).map((acknowledgement) => ({
      note_record_id: acknowledgement.note_id,
      session_id: acknowledgement.session_id,
    }))
  return db()
    .query<{ note_record_id: string; session_id: string }, []>(
      'SELECT note_record_id,session_id FROM note_acknowledgement',
    )
    .all()
}

export function localNoteAcknowledgementSightings(
  noteRecordId: string,
  sessionId: string,
): number | null {
  return (
    db()
      .query<{ sightings: number }, [string, string]>(
        'SELECT sightings FROM note_acknowledgement WHERE note_record_id=? AND session_id=?',
      )
      .get(noteRecordId, sessionId)?.sightings ?? null
  )
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

function listLocalFilteredRows<Row extends { text: string }>(
  filters: NormalizedNoteFilters,
  projection: string,
): Row[] {
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
  if (filters.promotedTo) {
    clauses.push('note.promoted_task = ?')
    values.push(filters.promotedTo)
  }
  if (filters.reference) {
    const reference = parseSlimNoteReference(filters.reference)
    if ('recordId' in reference) {
      clauses.push('lower(note.record_id) = ?')
      values.push(reference.recordId)
    } else {
      clauses.push('note.project = ? AND note.number = ?')
      values.push(reference.project, reference.number)
    }
  }
  const rows = db()
    .query<Row, (string | number)[]>(
      `SELECT ${projection} FROM note ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY note.last_seen_at DESC, note.record_id DESC`,
    )
    .all(...values)
  const search = filters.text?.toLowerCase()
  return search ? rows.filter((row) => row.text.toLowerCase().includes(search)) : rows
}

function listLocalNotes(filters: NormalizedNoteFilters): NoteRow[] {
  return listLocalFilteredRows<Omit<NoteRow, 'anchors' | 'label'> & { anchors: string }>(
    filters,
    'note.*',
  ).map(decodeNoteRow)
}

function slimNote(row: NoteRow): SlimNote {
  const {
    record_id,
    label,
    number,
    project,
    text,
    sightings,
    created_at,
    last_seen_at,
    stale_at,
    stale_reason,
    promoted_task,
  } = row
  return {
    record_id,
    label,
    number,
    project,
    text,
    sightings,
    created_at,
    last_seen_at,
    stale_at,
    stale_reason,
    promoted_task,
  }
}

function listLocalSlimNotes(
  filters: NormalizedNoteFilters,
  limit: number | undefined,
): { notes: SlimNote[]; total: number } {
  const matching = listLocalFilteredRows<Omit<SlimNote, 'label'>>(
    filters,
    `note.record_id,note.number,note.project,note.text,note.sightings,note.created_at,
     note.last_seen_at,note.stale_at,note.stale_reason,note.promoted_task`,
  )
  const selected = limit === undefined ? matching : matching.slice(0, limit)
  return {
    notes: selected.map((row) => ({
      ...row,
      label: formatNoteLabel(row.project, row.number),
    })),
    total: matching.length,
  }
}

const readRemedy = `run \`${PLATFORM_SLUG} record doctor\`, then retry`

function hostedReadFailure(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause)
  return new Error(message.endsWith(readRemedy) ? message : `${message}. ${readRemedy}`)
}

function hostedUrlWithoutUserinfo(hosted: NoteClientOptions | undefined): string {
  const resolved = hosted?.baseUrl ?? resolveHostedUrl()
  if (!resolved) throw new Error('hosted hub is not configured')
  const url = new URL(resolved)
  url.username = ''
  url.password = ''
  return url.toString()
}

class NoteNotFoundError extends Error {
  constructor(recordId: string) {
    super(`no note ${recordId}`)
  }
}

function spaceReadFailure(recordSpace: string, project: string | undefined, cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause)
  const owner = project ? `project ${project}` : `record space ${recordSpace}`
  return new Error(`${owner}: ${message}`, { cause })
}

async function readHostedNote(
  recordId: string,
  options: NoteClientOptions = {},
  project?: string,
): Promise<NoteRow> {
  const spaces = await noteReadSpaces(project, options)
  try {
    for (const recordSpace of spaces) {
      let hostedNote: Awaited<ReturnType<typeof hostedGetNote>>
      try {
        hostedNote = await hostedGetNote(recordId, { ...options, recordSpace })
      } catch (cause) {
        if (isMissingHostedNote(cause)) continue
        throw spaceReadFailure(recordSpace, project, cause)
      }
      return noteRowFromHosted(hostedNote)
    }
    throw new NoteNotFoundError(recordId)
  } catch (cause) {
    if (cause instanceof NoteNotFoundError) throw cause
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
  options: NoteClientOptions = {},
): Promise<NoteRow[]> {
  const spaces = await noteReadSpaces(filters.project, options)
  try {
    const notesById = new Map<
      string,
      { note: ReturnType<typeof noteRowFromHosted>; space: string }
    >()
    const acknowledgements: HostedAcknowledgement[] = []
    const results = await Promise.all(
      spaces.map(async (recordSpace) => ({
        recordSpace,
        result: await hostedListNotes(
          {
            project: filters.project,
            stale: filters.stale,
            actionable: filters.actionable,
          },
          { ...options, recordSpace },
        ).catch((cause) => {
          throw spaceReadFailure(recordSpace, filters.project, cause)
        }),
      })),
    )
    for (const { recordSpace, result } of results) {
      acknowledgements.push(...result.acknowledgements)
      for (const hostedNote of result.notes) {
        const note = noteRowFromHosted(hostedNote)
        const existing = notesById.get(note.record_id)
        if (existing)
          throw new Error(
            `note ${note.record_id} appears in record spaces ${existing.space} and ${recordSpace}`,
          )
        notesById.set(note.record_id, { note, space: recordSpace })
      }
    }
    const search = filters.text?.toLowerCase()
    return [...notesById.values()]
      .map(({ note }) => note)
      .filter((note) =>
        filters.sessions.length
          ? note.anchors.some((anchor) =>
              filters.sessions.includes(
                typeof anchor.session_id === 'string' ? anchor.session_id : '',
              ),
            ) &&
            filters.kept ===
              acknowledgements.some((acknowledgement) =>
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

async function listHostedSlimNoteRows(
  filters: NormalizedNoteFilters,
  limit: number | undefined,
  options: NoteClientOptions = {},
): Promise<{ notes: SlimNote[]; total: number }> {
  const spaces = await noteReadSpaces(filters.project, options)
  try {
    const results = await Promise.all(
      spaces.map(async (recordSpace) => ({
        recordSpace,
        result: await hostedListSlimNotes(
          {
            project: filters.project,
            stale: filters.stale,
            actionable: filters.actionable,
            promotedTo: filters.promotedTo,
            reference: filters.reference,
            sessions: filters.sessions,
            kept: filters.sessions.length ? Boolean(filters.kept) : undefined,
            text: filters.text,
            limit,
          },
          { ...options, recordSpace },
        ).catch((cause) => {
          throw spaceReadFailure(recordSpace, filters.project, cause)
        }),
      })),
    )
    const notesById = new Map<string, { note: SlimNote; space: string }>()
    let total = 0
    for (const { recordSpace, result } of results) {
      total += result.total
      for (const note of result.notes) {
        const existing = notesById.get(note.record_id)
        if (existing)
          throw new Error(
            `note ${note.record_id} appears in record spaces ${existing.space} and ${recordSpace}`,
          )
        notesById.set(note.record_id, { note, space: recordSpace })
      }
    }
    const notes = [...notesById.values()]
      .map(({ note }) => note)
      .sort(
        (left, right) =>
          right.last_seen_at.localeCompare(left.last_seen_at) ||
          right.record_id.localeCompare(left.record_id),
      )
    return { notes: limit === undefined ? notes : notes.slice(0, limit), total }
  } catch (cause) {
    throw hostedReadFailure(cause)
  }
}

async function listSlimNotes(
  filters: NoteFilters & { limit?: number } = {},
  hosted?: NoteClientOptions,
): Promise<{ notes: SlimNote[]; total: number }> {
  const { limit: requestedLimit, ...noteFilters } = filters
  const limit = noteListLimit(requestedLimit)
  const normalized = normalizeNoteFilters(noteFilters)
  if (hostedWriteMode(hosted?.baseUrl ?? resolveHostedUrl()) === 'hosted-configured')
    return listHostedSlimNoteRows(normalized, limit, hosted)
  return listLocalSlimNotes(normalized, limit)
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

export async function listNoteDuplicateCandidates(
  project: string,
  text: string,
  hosted: NoteClientOptions | undefined,
  dependencies: { startCredentialResolution: () => void },
) {
  if (hostedWriteMode(hosted?.baseUrl ?? resolveHostedUrl()) !== 'hosted-configured')
    return listLocalNotes(normalizeNoteFilters({ project, actionable: true }))
  dependencies.startCredentialResolution()
  const spaces = await noteReadSpaces(project, hosted ?? {})
  try {
    const results = await Promise.all(
      spaces.map(async (recordSpace) => {
        const options = { ...hosted, recordSpace }
        try {
          return await hostedListNoteCandidates(project, text, options)
        } catch (cause) {
          if (isMissingHostedNote(cause))
            throw new Error(
              `the record at ${hostedUrlWithoutUserinfo(hosted)} has no note candidate route; it is older than this client. Retry after the hosted-hub rung deploys`,
              { cause },
            )
          throw spaceReadFailure(recordSpace, project, cause)
        }
      }),
    )
    return results.flat()
  } catch (cause) {
    throw hostedReadFailure(cause)
  }
}

export function listActionableNotes(
  filters: { project?: string; session?: string | string[]; text?: string } = {},
  hosted?: NoteClientOptions,
): Promise<NoteRow[]> {
  return listNotes({ ...filters, actionable: true }, hosted)
}

export async function listProjectSlimNotes(
  filters: NoteFilters & { limit?: number; hosted?: NoteClientOptions },
): Promise<{ notes: SlimNote[]; total: number }> {
  const limit = noteListLimit(filters.limit)
  if (filters.project && !isRegisteredNoteProject(filters.project)) {
    if (
      filters.stale ||
      filters.kept ||
      filters.actionable ||
      filters.promotedTo ||
      filters.reference
    )
      throw new Error(
        `outside project '${filters.project}' does not support these note filters; an outside project's notes support only text filtering; drop --stale, --kept, --actionable, --promoted-to and --reference`,
      )
    const rows = await listOutsideProjectNotes(filters.project, filters.hosted)
    const search = filters.text?.toLowerCase()
    const matching = search ? rows.filter((note) => note.text.toLowerCase().includes(search)) : rows
    return {
      notes: (limit === undefined ? matching : matching.slice(0, limit)).map(slimNote),
      total: matching.length,
    }
  }
  if (filters.actionable && filters.kept)
    throw new Error('--actionable and --kept are mutually exclusive')
  const normalized = normalizeSpecialSlimListFilters({
    ...filters,
    stale: Boolean(filters.stale),
  })
  if (normalized.kind === 'conflict') {
    const special = normalized.special === 'promotedTo' ? '--promoted-to' : '--reference'
    throw new Error(`${special} cannot be combined with --${normalized.state}`)
  }
  if (filters.kept && !filters.session)
    throw new Error(
      `${PLATFORM_SLUG} note list --kept requires --session ID or a session environment`,
    )
  const { hosted, ...localFilters } = filters
  return listSlimNotes(
    {
      ...localFilters,
      ...normalized.filters,
      kept: Boolean(filters.kept),
      limit,
    },
    hosted,
  )
}

export async function getNote(
  recordId: string,
  hosted?: NoteClientOptions,
  project?: string,
): Promise<NoteRow> {
  if (hostedWriteMode(hosted?.baseUrl ?? resolveHostedUrl()) === 'hosted-configured')
    return readHostedNote(recordId, hosted, project)
  const row = db()
    .query<Omit<NoteRow, 'anchors' | 'label'> & { anchors: string }, [string]>(
      'SELECT * FROM note WHERE record_id = ?',
    )
    .get(recordId)
  if (!row) throw new NoteNotFoundError(recordId)
  return decodeNoteRow(row)
}
