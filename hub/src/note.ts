import type { Database } from 'bun:sqlite'
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import { hasRecordIdShape } from '../../shared/record-id.ts'
import { projectOf } from './attribute.ts'
import { db, nowIso, writeTransaction } from './db.ts'
import { resolveHostedUrl } from './hosted-url.ts'
import {
  hostedUnavailableRemedy,
  hostedWriteMode,
  projectWriteDecisionFor,
} from './hosted-write-mode.ts'
import { readInstallBinding } from './install-binding.ts'
import { mergeNoteAnchors } from './note-anchor-merge.ts'
import { applyHostedNote } from './note-cache.ts'
import { hostedCreateNote, hostedPromoteNote, type NoteClientOptions } from './note-client.ts'
import { formatNoteLabel, parseNoteLabel } from './note-label.ts'
import { noteDestinationOptions } from './note-project-space.ts'
import { type NotePromotionAnchor, notePromotionBody } from './note-promotion-body.ts'
import { evaluateNoteStaleness, type StalenessAnchorObservation } from './note-staleness.ts'
import {
  applyHostedStaleness,
  applyLocalStaleness,
  type StalenessChange,
  type StalenessResult,
} from './note-staleness-store.ts'
import { applyHostedWriteLocally, drainHostedEditOutbox } from './offline-task-edits.ts'
import { dispatchNoteCurator, readRunsById } from './orch.ts'
import { queueHostedChange } from './outbox.ts'
import { projectRecordIdFor } from './project-record-id.ts'
import { projects, type RegisteredProject } from './projects.ts'
import { HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE, HOSTED_NOTE_TABLE } from './push-contract.ts'
import {
  attachLocalTaskEvidenceInTransaction,
  createLocalTaskInTransaction,
  duplicateCandidates,
  type TaskRow,
} from './task.ts'
import { applyHostedTask, applyHostedTaskComment } from './task-cache.ts'
import { taskCreationDestination } from './tracker-new.ts'

export type NoteAnchor = NotePromotionAnchor & {
  id?: string
  project: string
  files: { path: string; line: number; content: string }[]
  run_record_id?: string | null
}

export const NOTE_ANCHOR_MAX_FILE_BYTES = 1_000_000

const noteAnchorSchema: z.ZodType<NoteAnchor> = z.object({
  id: z.string().uuid().optional(),
  cwd: z.string(),
  project: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      line: z.number(),
      content: z.string(),
    }),
  ),
  run_id: z.number().nullable(),
  run_record_id: z.string().uuid().nullable().optional(),
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  session_id: z.string().nullable(),
})

export function parseNoteAnchor(value: unknown): NoteAnchor {
  return noteAnchorSchema.parse(value)
}

export function confineExplicitNoteAnchor(
  anchor: NoteAnchor,
  facts: { cwdProject: string | null; projectPath: string; realpath?: (path: string) => string },
): NoteAnchor {
  if (!facts.cwdProject) throw new Error('anchor.project: hub cwd has no registered project')
  if (anchor.project !== facts.cwdProject) {
    throw new Error(`anchor.project: expected '${facts.cwdProject}'`)
  }
  const realpath = facts.realpath ?? realpathSync
  const root = realpath(facts.projectPath)
  for (const [index, file] of anchor.files.entries()) {
    let path: string
    try {
      path = realpath(file.path)
    } catch {
      throw new Error(`anchor.files[${index}].path: cannot resolve inside the registered checkout`)
    }
    const fromRoot = relative(root, path)
    if (
      fromRoot === '..' ||
      fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new Error(`anchor.files[${index}].path: must resolve inside the registered checkout`)
    }
  }
  return anchor
}

export function parseExplicitNoteAnchor(value: unknown, cwd = process.cwd()): NoteAnchor {
  const anchor = parseNoteAnchor(value)
  const cwdProject = projectOf(cwd)
  const project = projects().find((candidate) => candidate.name === cwdProject)
  if (!project) throw new Error('anchor.project: hub cwd has no registered project')
  return confineExplicitNoteAnchor(anchor, { cwdProject, projectPath: project.path })
}

export type NoteRow = {
  record_id: string
  number: number
  label: string
  project: string
  text: string
  area: string | null
  anchors: NoteAnchor[]
  sightings: number
  created_at: string
  last_seen_at: string
  stale_at: string | null
  stale_reason: string | null
  promoted_task: string | null
}

export type NoteCandidate = {
  record_id: string
  number: number
  label: string
  project: string
  text: string
  score: number
}
export type NoteAcknowledgement = { note: NoteRow; alreadyAcknowledged: boolean }

const git = (cwd: string, ...args: string[]): string | null => {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'ignore' })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}

function decode(row: Omit<NoteRow, 'anchors' | 'label'> & { anchors: string }): NoteRow {
  return {
    ...row,
    label: formatNoteLabel(row.project, row.number),
    anchors: JSON.parse(row.anchors) as NoteAnchor[],
  }
}

function noteRowFromHosted(row: Awaited<ReturnType<typeof hostedCreateNote>>): NoteRow {
  return decode({
    record_id: row.id,
    number: row.number,
    project: row.project,
    text: row.text,
    area: row.area,
    anchors: row.anchors,
    sightings: row.sightings,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    stale_at: row.stale_at,
    stale_reason: row.stale_reason,
    promoted_task: row.promoted_task,
  })
}

function registeredProject(name: string): RegisteredProject {
  const project = projects().find((candidate) => candidate.name === name)
  if (!project)
    throw new Error(`project '${name}' is not registered; run \`${PLATFORM_SLUG} project list\``)
  return project
}

function writeMode(
  projectName: string,
  hosted?: NoteClientOptions,
): 'hosted-configured' | 'local-authoritative' {
  const project = projects().find((candidate) => candidate.name === projectName)
  if (!project) throw new Error(`unknown project '${projectName}'`)
  const decision = projectWriteDecisionFor(
    project,
    readInstallBinding(),
    hosted?.baseUrl ?? resolveHostedUrl(),
  )
  if (decision.mode === 'refused') throw new Error(decision.reason)
  return decision.mode
}

function noteRow(
  conn: Database,
  recordId: string,
): Omit<NoteRow, 'anchors' | 'label'> & { anchors: string } {
  const row = conn
    .query<Omit<NoteRow, 'anchors' | 'label'> & { anchors: string }, [string]>(
      'SELECT * FROM note WHERE record_id = ?',
    )
    .get(recordId)
  if (!row) throw new Error(`no note ${recordId}`)
  return row
}

function mintLocalNoteNumber(conn: Database, project: string): number {
  const number =
    conn
      .query<{ next: number }, [string]>('SELECT next FROM note_counter WHERE project=?')
      .get(project)?.next ?? 1
  conn
    .query(
      `INSERT INTO note_counter (record_id, project, project_record_id, next) VALUES (?, ?, ?, ?)
       ON CONFLICT(project) DO UPDATE SET next = MAX(note_counter.next, excluded.next),
       project_record_id=COALESCE(excluded.project_record_id,note_counter.project_record_id)`,
    )
    .run(newRecordId(), project, projectRecordIdFor(project), number + 1)
  return number
}

function boundedNoteLine(path: string, requested: number): string | null {
  const fd = openSync(path, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > NOTE_ANCHOR_MAX_FILE_BYTES) return null
    const bytes: number[] = []
    const byte = Buffer.allocUnsafe(1)
    let line = 1
    let total = 0
    while (readSync(fd, byte, 0, 1, null) === 1) {
      total += 1
      if (total > NOTE_ANCHOR_MAX_FILE_BYTES) return null
      if (byte[0] === 10) {
        if (line === requested) return Buffer.from(bytes).toString('utf8').replace(/\r$/, '')
        line += 1
        continue
      }
      if (line === requested) bytes.push(byte[0]!)
    }
    return line === requested ? Buffer.from(bytes).toString('utf8').replace(/\r$/, '') : null
  } finally {
    closeSync(fd)
  }
}

/** Derive only bounded file facts whose real paths stay strictly inside the checkout. */
export function deriveNoteFileAnchors(text: string, projectPath: string): NoteAnchor['files'] {
  let root: string
  try {
    root = realpathSync(projectPath)
  } catch {
    return []
  }
  return [...text.matchAll(/(?:^|[\s`(])([^\s`():]+):(\d+)\b/g)].flatMap((match) => {
    const line = Number(match[2])
    let path: string
    try {
      path = realpathSync(isAbsolute(match[1]!) ? match[1]! : resolve(root, match[1]!))
    } catch {
      return []
    }
    const fromRoot = relative(root, path)
    if (
      !fromRoot ||
      fromRoot === '..' ||
      fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(fromRoot)
    ) {
      return []
    }
    try {
      const content = boundedNoteLine(path, line)
      return content === null ? [] : [{ path, line, content }]
    } catch {
      return []
    }
  })
}

export function deriveNoteAnchor(text: string, cwd = process.cwd(), env = process.env): NoteAnchor {
  const project = projectOf(cwd)
  if (!project) throw new Error(`cannot file note: no registered project contains ${cwd}`)
  const projectPath = projects().find((candidate) => candidate.name === project)?.path ?? cwd
  const files = deriveNoteFileAnchors(text, projectPath)
  const runRecordId = env.BOTTEGA_RUN_ID
  const runNumber = Number(env.BOTTEGA_RUN_NUMBER)
  return {
    id: newRecordId(),
    cwd,
    project,
    files,
    run_id: Number.isSafeInteger(runNumber) && runNumber > 0 ? runNumber : null,
    run_record_id: runRecordId && hasRecordIdShape(runRecordId) ? runRecordId.toLowerCase() : null,
    branch: git(cwd, 'branch', '--show-current') || null,
    commit: git(cwd, 'rev-parse', 'HEAD') || null,
    session_id: env.CLAUDE_CODE_SESSION_ID ?? env.CODEX_THREAD_ID ?? null,
  }
}

export function noteSessionId(env = process.env): string | null {
  return env.CLAUDE_CODE_SESSION_ID ?? env.CODEX_THREAD_ID ?? null
}

function identifiedAnchor(anchor: NoteAnchor): NoteAnchor {
  return anchor.id ? anchor : { ...anchor, id: newRecordId() }
}

export function listNotes(
  filters: {
    project?: string
    stale?: boolean
    session?: string | string[]
    actionable?: boolean
    kept?: boolean
    text?: string
  } = {},
): NoteRow[] {
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
    registeredProject(filters.project)
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
  const matched = search ? rows.filter((row) => row.text.toLowerCase().includes(search)) : rows
  return matched.map(decode)
}

export function listActionableNotes(
  filters: { project?: string; session?: string | string[]; text?: string } = {},
): NoteRow[] {
  return listNotes({ ...filters, actionable: true })
}

export function getNote(recordId: string): NoteRow {
  const row = db()
    .query<Omit<NoteRow, 'anchors' | 'label'> & { anchors: string }, [string]>(
      'SELECT * FROM note WHERE record_id = ?',
    )
    .get(recordId)
  if (!row) throw new Error(`no note ${recordId}`)
  return decode(row)
}

export function resolveNoteReference(value: string, sessionProject: string | null): string {
  if (hasRecordIdShape(value)) {
    const recordId = value.toLowerCase()
    if (db().query('SELECT 1 FROM note WHERE record_id=?').get(recordId)) return recordId
    throw new Error(
      `no note ${recordId}; use a project#number label or run \`${PLATFORM_SLUG} note list\``,
    )
  }
  let project: string | null = sessionProject
  let number: number
  const isLabel = value.includes('#')
  if (isLabel) {
    const label = parseNoteLabel(value)
    registeredProject(label.project)
    project = label.project
    number = label.number
  } else {
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error(`invalid note '${value}': expected project#number, a number, or a UUID`)
    }
    number = Number(value)
  }
  const inProject = project
    ? db()
        .query<{ record_id: string }, [string, number]>(
          'SELECT record_id FROM note WHERE project=? AND number=?',
        )
        .get(project, number)
    : null
  if (inProject) return inProject.record_id
  const expected = formatNoteLabel(project ?? '<project>', number)
  throw new Error(
    `no note ${expected}; use a project#number label or run \`${PLATFORM_SLUG} note list\``,
  )
}

export async function acknowledgeNote(
  recordId: string,
  session: string,
  options: { hosted?: NoteClientOptions } = {},
): Promise<NoteAcknowledgement> {
  const sessionId = session.trim()
  if (!sessionId) throw new Error('cannot keep note: no session identity')
  const note = getNote(recordId)
  const existing = db()
    .query<{ sightings: number }, [string, string]>(
      'SELECT sightings FROM note_acknowledgement WHERE note_record_id=? AND session_id=?',
    )
    .get(note.record_id, sessionId)
  if (existing?.sightings === note.sightings) return { note, alreadyAcknowledged: true }
  const mode = writeMode(note.project, options.hosted)
  const queuedAt = nowIso()
  writeTransaction((conn) => {
    const row = decode(noteRow(conn, note.record_id))
    conn
      .query(
        `INSERT INTO note_acknowledgement (record_id,note_record_id,session_id,acknowledged_at,sightings)
         VALUES (?,?,?,?,?) ON CONFLICT(note_record_id,session_id) DO UPDATE SET
         acknowledged_at=excluded.acknowledged_at,sightings=excluded.sightings`,
      )
      .run(newRecordId(), row.record_id, sessionId, queuedAt, row.sightings)
    if (mode === 'hosted-configured') {
      const acknowledgement = conn
        .query<{ record_id: string }, [string, string]>(
          'SELECT record_id FROM note_acknowledgement WHERE note_record_id=? AND session_id=?',
        )
        .get(row.record_id, sessionId)!
      queueHostedChange(
        conn,
        HOSTED_NOTE_ACKNOWLEDGEMENT_TABLE,
        acknowledgement.record_id,
        'upsert',
        queuedAt,
      )
    }
  })
  if (mode === 'hosted-configured') await drainHostedEditOutbox(queuedAt, options.hosted)
  return { note: getNote(note.record_id), alreadyAcknowledged: false }
}

function noteCandidates(text: string, project?: string): NoteCandidate[] {
  const notes = listNotes({ ...(project ? { project } : {}), stale: false })
  const byId = new Map(notes.map((note) => [note.record_id, note]))
  return duplicateCandidates(
    notes.map(
      (note): TaskRow => ({
        record_id: note.record_id,
        external_id: null,
        key: note.record_id,
        project: note.project,
        title: note.text,
        status: null,
        status_category: null,
        parent_key: null,
        parent_record_id: null,
        body: null,
        assignee: null,
        opened_at: note.created_at,
        closed_at: null,
        updated_at: note.last_seen_at,
        source: 'local',
        first_seen: note.created_at,
        last_seen: note.last_seen_at,
        next_document_number: 1,
      }),
    ),
    text,
  ).map((candidate) => {
    const note = byId.get(candidate.key)!
    return {
      record_id: note.record_id,
      number: note.number,
      label: note.label,
      project: note.project,
      text: note.text,
      score: candidate.score,
    }
  })
}

export async function mergeNote(
  targetRecordId: string,
  sourceRecordId: string,
  options: { hosted?: NoteClientOptions } = {},
): Promise<NoteRow> {
  if (targetRecordId === sourceRecordId) throw new Error('a note cannot be merged with itself')
  const target = getNote(targetRecordId)
  const sourceNote = getNote(sourceRecordId)
  if (target.project !== sourceNote.project)
    throw new Error('notes from different projects cannot be merged')
  const mode = writeMode(target.project, options.hosted)
  if (mode === 'local-authoritative') {
    writeTransaction((conn) => {
      const current = decode(noteRow(conn, targetRecordId))
      const source = decode(noteRow(conn, sourceRecordId))
      if (current.project !== source.project)
        throw new Error('notes from different projects cannot be merged')
      const lastSeen =
        current.last_seen_at > source.last_seen_at ? current.last_seen_at : source.last_seen_at
      const merged = mergeNoteAnchors(current.anchors, source.anchors.map(identifiedAnchor))
      conn
        .query(`UPDATE note SET anchors=?, sightings=?, last_seen_at=? WHERE record_id=?`)
        .run(JSON.stringify(merged.anchors), merged.sightings, lastSeen, current.record_id)
      conn.query('DELETE FROM note WHERE record_id=?').run(source.record_id)
    })
    return getNote(targetRecordId)
  }
  const queuedAt = nowIso()
  writeTransaction((conn) => {
    const current = decode(noteRow(conn, targetRecordId))
    const source = decode(noteRow(conn, sourceRecordId))
    const merged = mergeNoteAnchors(current.anchors, source.anchors.map(identifiedAnchor))
    const lastSeen =
      current.last_seen_at > source.last_seen_at ? current.last_seen_at : source.last_seen_at
    conn
      .query(`UPDATE note SET anchors=?,sightings=?,last_seen_at=? WHERE record_id=?`)
      .run(JSON.stringify(merged.anchors), merged.sightings, lastSeen, current.record_id)
    queueHostedChange(conn, HOSTED_NOTE_TABLE, current.record_id, 'upsert', queuedAt, [
      'anchors',
      'last_seen_at',
    ])
    conn.query('DELETE FROM note WHERE record_id=?').run(sourceRecordId)
    queueHostedChange(conn, HOSTED_NOTE_TABLE, sourceRecordId, 'delete', queuedAt)
    conn
      .query(
        `UPDATE hosted_outbox SET routing_project=?, routing_project_record_id=? WHERE table_name=? AND row_id=?`,
      )
      .run(target.project, projectRecordIdFor(target.project), HOSTED_NOTE_TABLE, sourceRecordId)
  })
  await drainHostedEditOutbox(queuedAt, options.hosted)
  return getNote(targetRecordId)
}

export async function createNote(
  input: {
    text: string
    cwd?: string
    area?: string
    sameAs?: string
    forceNew?: boolean
    anchor?: NoteAnchor
    project?: string
  },
  options: { hosted?: NoteClientOptions } = {},
): Promise<{ note: NoteRow; candidates: NoteCandidate[] }> {
  const text = input.text.trim()
  if (!text) throw new Error('note text is required')
  if (input.sameAs && input.forceNew) throw new Error('--same-as and --new are mutually exclusive')
  const anchor = identifiedAnchor(input.anchor ?? deriveNoteAnchor(text, input.cwd))
  const targetProject = input.project ?? anchor.project
  const registered = registeredProject(targetProject)
  const candidates = noteCandidates(text, targetProject)
  const mode = writeMode(targetProject, options.hosted)
  if (input.sameAs) {
    const existing = getNote(input.sameAs)
    if (existing.project !== targetProject)
      throw new Error('the matching note belongs to another project')
    if (mode === 'local-authoritative') {
      const at = nowIso()
      writeTransaction((conn) => {
        const row = decode(noteRow(conn, existing.record_id))
        if (row.project !== targetProject)
          throw new Error('the matching note belongs to another project')
        conn
          .query(
            `UPDATE note SET anchors=?, sightings=sightings+1, last_seen_at=?, stale_at=NULL, stale_reason=NULL WHERE record_id=?`,
          )
          .run(JSON.stringify([...row.anchors, anchor]), at, row.record_id)
      })
      return { note: getNote(existing.record_id), candidates }
    }
    const queuedAt = nowIso()
    writeTransaction((conn) => {
      const row = decode(noteRow(conn, existing.record_id))
      const merged = mergeNoteAnchors(row.anchors, [anchor])
      conn
        .query(
          `UPDATE note SET anchors=?,sightings=?,last_seen_at=?,stale_at=NULL,stale_reason=NULL WHERE record_id=?`,
        )
        .run(JSON.stringify(merged.anchors), merged.sightings, queuedAt, row.record_id)
      queueHostedChange(conn, HOSTED_NOTE_TABLE, row.record_id, 'upsert', queuedAt, [
        'anchors',
        'last_seen_at',
      ])
    })
    await drainHostedEditOutbox(queuedAt, options.hosted)
    return { note: getNote(existing.record_id), candidates }
  }
  if (candidates.length && !input.forceNew) return { note: null as never, candidates }
  if (mode === 'local-authoritative') {
    const at = nowIso()
    const recordId = writeTransaction((conn) => {
      const number = mintLocalNoteNumber(conn, targetProject)
      const recordId = newRecordId()
      conn
        .query(
          `INSERT INTO note (record_id,number,project,project_record_id,text,area,anchors,sightings,created_at,last_seen_at)
       VALUES (?,?,?,?,?,?,?,1,?,?)`,
        )
        .run(
          recordId,
          number,
          targetProject,
          projectRecordIdFor(targetProject),
          text,
          input.area?.trim() || null,
          JSON.stringify([anchor]),
          at,
          at,
        )
      return recordId
    })
    return { note: getNote(recordId), candidates }
  }
  const hostedOptions = await noteDestinationOptions(targetProject, options.hosted)
  const hosted = await hostedCreateNote(
    {
      project: targetProject,
      projectId: registered.record_id,
      text,
      area: input.area?.trim() || null,
      anchor: JSON.stringify(anchor),
    },
    hostedOptions,
  )
  const applied = applyHostedWriteLocally(
    formatNoteLabel(hosted.project, hosted.number),
    'created',
    () => writeTransaction((conn) => applyHostedNote(conn, hosted)),
  )
  return { note: applied ? getNote(hosted.id) : noteRowFromHosted(hosted), candidates }
}

/** The refusal every creating promotion carries, so no surface can create a task titled by a note. */
export function promotionTitleRefusal(label: string): string {
  return `${PLATFORM_SLUG} note promote ${label} --title "<the point>"`
}

/** A creating promotion names the new task's title; a linking promotion carries none. */
export function requiredPromotionTitle(label: string, supplied: string | undefined): string {
  const title = (supplied ?? '').trim()
  if (!title) throw new Error(promotionTitleRefusal(label))
  return title
}

export async function promoteNote(
  recordId: string,
  options: {
    hosted?: NoteClientOptions
    existingTaskKey?: string
    title?: string
  } = {},
): Promise<NoteRow> {
  const note = getNote(recordId)
  if (note.promoted_task)
    throw new Error(`note ${note.label} is already promoted to ${note.promoted_task}`)
  const creating = options.existingTaskKey === undefined
  const title = creating ? requiredPromotionTitle(note.label, options.title) : ''
  const project = projects().find((candidate) => candidate.name === note.project)!
  const destination = taskCreationDestination(project)
  if (destination === 'tracker' && !options.existingTaskKey)
    throw new Error(
      `project ${note.project} owns task creation in its tracker; create the task there, then link it with: ${PLATFORM_SLUG} note promote ${note.label} --task <KEY>`,
    )
  if (options.existingTaskKey) {
    const prefixes = project.settings.keyPrefixes ?? []
    const prefix = options.existingTaskKey.split('-', 1)[0]?.toUpperCase()
    if (!prefix || !prefixes.some((candidate) => candidate.toUpperCase() === prefix))
      throw new Error(
        `task key '${options.existingTaskKey}' has the wrong prefix for project ${note.project}; expected: ${prefixes.join(', ')}`,
      )
  }
  const mode = writeMode(note.project, options.hosted)
  if (mode === 'local-authoritative') {
    if (destination === 'tracker') {
      writeTransaction((conn) => {
        const row = decode(noteRow(conn, note.record_id))
        if (row.promoted_task)
          throw new Error(`note ${row.label} is already promoted to ${row.promoted_task}`)
        conn
          .query(
            'UPDATE note SET promoted_task=?, promoted_task_record_id=NULL, last_seen_at=? WHERE record_id=?',
          )
          .run(options.existingTaskKey!, nowIso(), row.record_id)
      })
      return getNote(note.record_id)
    }
    if (options.existingTaskKey) {
      writeTransaction((conn) => {
        const row = decode(noteRow(conn, note.record_id))
        if (row.promoted_task)
          throw new Error(`note ${row.label} is already promoted to ${row.promoted_task}`)
        const at = nowIso()
        const task = attachLocalTaskEvidenceInTransaction(
          conn,
          options.existingTaskKey!,
          row.project,
          notePromotionBody(row.text, row.sightings, row.anchors),
          at,
        )
        conn
          .query(
            'UPDATE note SET promoted_task=?, promoted_task_record_id=?, last_seen_at=? WHERE record_id=?',
          )
          .run(task.task_key, task.task_record_id, at, row.record_id)
      })
      return getNote(note.record_id)
    }
    writeTransaction((conn) => {
      const row = decode(noteRow(conn, note.record_id))
      if (row.promoted_task)
        throw new Error(`note ${row.label} is already promoted to ${row.promoted_task}`)
      const task = createLocalTaskInTransaction(
        conn,
        {
          project: row.project,
          title,
          body: notePromotionBody(row.text, row.sightings, row.anchors),
        },
        { skipDuplicateCheck: true },
      )
      conn
        .query(
          'UPDATE note SET promoted_task=?, promoted_task_record_id=?, last_seen_at=? WHERE record_id=?',
        )
        .run(task.key, task.record_id, nowIso(), row.record_id)
    })
    return getNote(note.record_id)
  }
  const hostedOptions = await noteDestinationOptions(note.project, options.hosted)
  const promoteInput = { task: options.existingTaskKey, title: creating ? title : undefined }
  const hosted = await hostedPromoteNote(note.record_id, promoteInput, hostedOptions)
  const reference = hosted.task?.key ?? formatNoteLabel(hosted.note.project, hosted.note.number)
  const applied = applyHostedWriteLocally(reference, 'updated', () =>
    writeTransaction((conn) => {
      if (hosted.task) applyHostedTask(conn, hosted.task)
      if (hosted.comment) applyHostedTaskComment(conn, hosted.comment)
      applyHostedNote(conn, hosted.note)
    }),
  )
  return applied ? getNote(note.record_id) : noteRowFromHosted(hosted.note)
}

export function promotionTaskInput(note: NoteRow, title: string) {
  return { title, body: notePromotionBody(note.text, note.sightings, note.anchors) }
}

export async function dropNote(
  recordId: string,
  reason: string,
  options: { hosted?: NoteClientOptions } = {},
): Promise<NoteRow> {
  if (!reason.trim()) throw new Error('--reason is required')
  const current = getNote(recordId)
  const mode = writeMode(current.project, options.hosted)
  if (mode === 'local-authoritative') {
    const at = nowIso()
    writeTransaction((conn) => {
      noteRow(conn, recordId)
      conn
        .query(`UPDATE note SET stale_at=?, stale_reason=?, last_seen_at=? WHERE record_id=?`)
        .run(at, `dropped: ${reason.trim()}`, at, recordId)
    })
    return getNote(recordId)
  }
  const queuedAt = nowIso()
  writeTransaction((conn) => {
    noteRow(conn, recordId)
    conn
      .query(`UPDATE note SET stale_at=?,stale_reason=?,last_seen_at=? WHERE record_id=?`)
      .run(queuedAt, `dropped: ${reason.trim()}`, queuedAt, recordId)
    queueHostedChange(conn, HOSTED_NOTE_TABLE, recordId, 'upsert', queuedAt, [
      'stale_at',
      'stale_reason',
      'last_seen_at',
    ])
  })
  await drainHostedEditOutbox(queuedAt, options.hosted)
  return getNote(recordId)
}

export type StaleResult = StalenessResult

type StaleDeps = {
  runExists(ids: string[]): Promise<Set<string>>
  git(cwd: string, ...args: string[]): string | null
  readFile(path: string): string | null
  now(): Date
  hosted: NoteClientOptions
}

async function defaultRunExists(ids: string[]): Promise<Set<string>> {
  const rows = await readRunsById(ids)
  return new Set(rows.flatMap((row) => ('unknown' in row ? [] : [row.record_id])))
}

const stalenessFileReader = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function observeStalenessAnchor(
  anchor: NoteAnchor,
  noteProject: string,
  registered: Array<{ name: string; path: string; trunk: string }>,
  existingRuns: Set<string>,
  runGit: StaleDeps['git'],
  readFile: StaleDeps['readFile'],
): StalenessAnchorObservation {
  const projectName = anchor.project || noteProject
  const project = registered.find((candidate) => candidate.name === projectName)
  const files = anchor.files.map((file) => {
    const path = isAbsolute(file.path) ? file.path : resolve(anchor.cwd, file.path)
    const contents = readFile(path)
    const anchored = file.content.trim()
    return {
      path: file.path,
      line: file.line,
      exists: contents !== null,
      containsAnchoredContent:
        contents !== null &&
        (!anchored || contents.split(/\r?\n/).some((line) => line.trim() === anchored)),
    }
  })
  let branch: StalenessAnchorObservation['branch'] = null
  if (project && anchor.branch && anchor.branch !== project.trunk) {
    const exists =
      runGit(project.path, 'show-ref', '--verify', `refs/heads/${anchor.branch}`) !== null
    branch = {
      name: anchor.branch,
      trunk: project.trunk,
      exists,
      landed:
        exists &&
        runGit(project.path, 'merge-base', '--is-ancestor', anchor.branch, project.trunk) !== null,
    }
  }
  return {
    sessionId: anchor.session_id,
    projectFound: project !== undefined,
    files,
    run: anchor.run_record_id
      ? {
          label: anchor.run_id ?? anchor.run_record_id,
          exists: existingRuns.has(anchor.run_record_id),
        }
      : null,
    branch,
  }
}

export async function staleNotes(deps: Partial<StaleDeps> = {}): Promise<StaleResult> {
  const runGit = deps.git ?? git
  const readFile = deps.readFile ?? stalenessFileReader
  const clock = deps.now?.() ?? new Date()
  const notes = listNotes()
  const runIds = [
    ...new Set(
      notes.flatMap((note) =>
        note.anchors.flatMap((anchor) => (anchor.run_record_id ? [anchor.run_record_id] : [])),
      ),
    ),
  ]
  const existingRuns = await (deps.runExists ?? defaultRunExists)(runIds)
  const acknowledgements = db()
    .query<{ note_record_id: string; session_id: string }, []>(
      'SELECT note_record_id,session_id FROM note_acknowledgement',
    )
    .all()
  const acknowledgementSessions = new Map<string, string[]>()
  for (const acknowledgement of acknowledgements) {
    const sessions = acknowledgementSessions.get(acknowledgement.note_record_id) ?? []
    sessions.push(acknowledgement.session_id)
    acknowledgementSessions.set(acknowledgement.note_record_id, sessions)
  }
  const registered = projects().map((project) => ({
    name: project.name,
    path: project.path,
    trunk: typeof project.settings.trunk === 'string' ? project.settings.trunk : 'main',
  }))
  const evaluations = notes.map((note) => {
    const anchors = note.anchors.map((anchor) =>
      observeStalenessAnchor(anchor, note.project, registered, existingRuns, runGit, readFile),
    )
    const outcome = evaluateNoteStaleness({
      note: {
        anchors,
        promotedTask: note.promoted_task,
        staleAt: note.stale_at,
        staleReason: note.stale_reason,
      },
      acknowledgementSessions: acknowledgementSessions.get(note.record_id) ?? [],
    })
    return { note, outcome }
  })
  const changes = evaluations.flatMap(({ note, outcome }): StalenessChange[] =>
    outcome.action === 'unchanged'
      ? []
      : [
          {
            recordId: note.record_id,
            label: note.label,
            project: note.project,
            action: outcome.action,
            reason: outcome.reason,
          },
        ],
  )
  const at = clock.toISOString()
  const cutoff = new Date(clock.getTime() - 30 * 86_400_000).toISOString()
  const deletedRows = evaluations.flatMap(({ note, outcome }) =>
    note.sightings === 1 &&
    note.last_seen_at <= cutoff &&
    note.promoted_task === null &&
    outcome.triaged &&
    (outcome.action === 'mark' || (note.stale_at !== null && outcome.action !== 'restore'))
      ? [{ record_id: note.record_id, project: note.project }]
      : [],
  )
  const deletedIds = deletedRows.map((row) => row.record_id)
  const url = deps.hosted?.baseUrl ?? resolveHostedUrl()
  if (hostedWriteMode(url) !== 'hosted-configured' && readInstallBinding().bound) {
    throw new Error(
      `this install belongs to a hosted space; local writes are refused while hosting is unavailable. ${hostedUnavailableRemedy(url)}`,
    )
  }
  if (hostedWriteMode(url) !== 'hosted-configured') {
    return applyLocalStaleness(changes, deletedIds, at, cutoff)
  }
  return applyHostedStaleness(changes, deletedRows, at, cutoff, projects(), deps.hosted)
}

export function curatorEnabled(): boolean {
  const row = db()
    .query<{ value: string }, []>("SELECT value FROM setting WHERE key='note.curator.enabled'")
    .get()
  return row?.value === 'true'
}

export function setCuratorEnabled(enabled: boolean): boolean {
  writeTransaction((conn) =>
    conn
      .query(
        "INSERT INTO setting(key,value) VALUES ('note.curator.enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(String(enabled)),
  )
  return enabled
}

export async function curateNotes(
  scheduled = false,
): Promise<{ project: string; result: string }[]> {
  if (scheduled && !curatorEnabled()) return []
  const results: { project: string; result: string }[] = []
  for (const project of projects()) {
    const notes = listActionableNotes({ project: project.name })
    if (!notes.length) continue
    const prompt = noteCuratorPrompt(notes)
    results.push({ project: project.name, result: await dispatchNoteCurator(project.path, prompt) })
  }
  return results
}

export function noteCuratorPrompt(notes: Pick<NoteRow, 'label' | 'text'>[]): string {
  return [
    'Re-read every open note below against this checkout. Return proposals only; make no changes.',
    'For each note return: still-holds, genuine-duplicate-of-project#number, earned-promotion, and area, with reasons.',
    `A human will act through ${PLATFORM_SLUG} note same, drop, or promote.`,
    '',
    ...notes.map((note) => `${note.label}: ${note.text}`),
  ].join('\n')
}
