import type { Database } from 'bun:sqlite'
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import { newRecordId } from '../../shared/record/schema.ts'
import { projectOf } from './attribute.ts'
import { db, nowIso, writeTransaction } from './db.ts'
import { confirmCount } from './hosted-tasks.ts'
import {
  hostedUnavailableRemedy,
  hostedWriteMode,
  projectWriteDecisionFor,
} from './hosted-write-mode.ts'
import { readInstallBinding } from './install-binding.ts'
import { applyHostedAcknowledgement, applyHostedNote } from './note-cache.ts'
import {
  hostedAcknowledgeNote,
  hostedCreateNote,
  hostedDropNote,
  hostedMergeNotes,
  hostedPromoteNote,
  hostedReapNotes,
  type NoteClientOptions,
} from './note-client.ts'
import { nextNoteNumber } from './note-number.ts'
import { dispatchNoteCurator, readRunsById } from './orch.ts'
import { projects } from './projects.ts'
import { createLocalTaskInTransaction, duplicateCandidates, type TaskRow } from './task.ts'
import { applyHostedTask } from './task-cache.ts'

export type NoteAnchor = {
  cwd: string
  project: string
  files: { path: string; line: number; content: string }[]
  run_id: number | null
  branch: string | null
  commit: string | null
  session_id: string | null
}

export const NOTE_ANCHOR_MAX_FILE_BYTES = 1_000_000

const noteAnchorSchema: z.ZodType<NoteAnchor> = z.object({
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
  id: number
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

export type NoteCandidate = { id: number; project: string; text: string; score: number }
export type NoteAcknowledgement = { note: NoteRow; alreadyAcknowledged: boolean }

const git = (cwd: string, ...args: string[]): string | null => {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'ignore' })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}

function noteId(value: number | string): number {
  const id = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`invalid note id '${value}'`)
  return id
}

function decode(row: Omit<NoteRow, 'anchors'> & { anchors: string }): NoteRow {
  return { ...row, anchors: JSON.parse(row.anchors) as NoteAnchor[] }
}

function registeredProject(name: string): void {
  if (!projects().some((candidate) => candidate.name === name))
    throw new Error(`unknown project '${name}'`)
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
    hosted?.baseUrl ?? process.env.HUB_HOSTED_URL,
  )
  if (decision.mode === 'refused') throw new Error(decision.reason)
  return decision.mode
}

function noteRow(conn: Database, id: number): Omit<NoteRow, 'anchors'> & { anchors: string } {
  const row = conn
    .query<Omit<NoteRow, 'anchors'> & { anchors: string }, [number]>(
      'SELECT * FROM note WHERE id = ?',
    )
    .get(id)
  if (!row) throw new Error(`no note ${id}`)
  return row
}

function mintLocalNoteNumber(conn: Database): number {
  const highest = BigInt(
    conn.query<{ max: number | null }, []>('SELECT max(id) max FROM note').get()?.max ?? 0,
  )
  const sequence = conn
    .query<{ next: number }, [string]>('SELECT next FROM seq WHERE name = ?')
    .get('note')
  const number = Number(nextNoteNumber(highest, BigInt(sequence?.next ?? 1)))
  conn
    .query(
      `INSERT INTO seq (name, next) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET next = excluded.next`,
    )
    .run('note', number + 1)
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
  const run = Number(env.ORCH_RUN_ID ?? 0)
  return {
    cwd,
    project,
    files,
    run_id: Number.isSafeInteger(run) && run > 0 ? run : null,
    branch: git(cwd, 'branch', '--show-current') || null,
    commit: git(cwd, 'rev-parse', 'HEAD') || null,
    session_id: env.CLAUDE_CODE_SESSION_ID ?? env.CODEX_THREAD_ID ?? null,
  }
}

export function noteSessionId(env = process.env): string | null {
  return env.CLAUDE_CODE_SESSION_ID ?? env.CODEX_THREAD_ID ?? null
}

export function listNotes(
  filters: {
    project?: string
    stale?: boolean
    session?: string | string[]
    actionable?: boolean
    kept?: boolean
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
       WHERE acknowledgement.note_id = note.id
         AND acknowledgement.session_id IN (${candidates})
         AND acknowledgement.sightings = note.sightings
    )`)
    values.push(...sessions)
  }
  if (filters.actionable) clauses.push('note.stale_at IS NULL AND note.promoted_task IS NULL')
  const rows = db()
    .query<Omit<NoteRow, 'anchors'> & { anchors: string }, (string | number)[]>(
      `SELECT note.* FROM note ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY note.last_seen_at DESC, note.id DESC`,
    )
    .all(...values)
  return rows.map(decode)
}

export function listActionableNotes(
  filters: { project?: string; session?: string | string[] } = {},
): NoteRow[] {
  return listNotes({ ...filters, actionable: true })
}

export function getNote(value: number | string): NoteRow {
  const id = noteId(value)
  const row = db()
    .query<Omit<NoteRow, 'anchors'> & { anchors: string }, [number]>(
      'SELECT * FROM note WHERE id = ?',
    )
    .get(id)
  if (!row) throw new Error(`no note ${id}`)
  return decode(row)
}

export async function acknowledgeNote(
  value: number | string,
  session: string,
  options: { hosted?: NoteClientOptions } = {},
): Promise<NoteAcknowledgement> {
  const sessionId = session.trim()
  if (!sessionId) throw new Error('cannot keep note: no session identity')
  const note = getNote(value)
  const existing = db()
    .query<{ sightings: number }, [number, string]>(
      'SELECT sightings FROM note_acknowledgement WHERE note_id=? AND session_id=?',
    )
    .get(note.id, sessionId)
  if (existing?.sightings === note.sightings) return { note, alreadyAcknowledged: true }
  const mode = writeMode(note.project, options.hosted)
  if (mode === 'local-authoritative') {
    writeTransaction((conn) => {
      const row = decode(noteRow(conn, note.id))
      conn
        .query(
          `INSERT INTO note_acknowledgement (record_id,note_id,session_id,acknowledged_at,sightings)
           VALUES (?,?,?,?,?)
           ON CONFLICT(note_id,session_id) DO UPDATE SET
             acknowledged_at=excluded.acknowledged_at, sightings=excluded.sightings`,
        )
        .run(newRecordId(), row.id, sessionId, nowIso(), row.sightings)
    })
    return { note: getNote(note.id), alreadyAcknowledged: false }
  }
  const hosted = await hostedAcknowledgeNote(note.id, sessionId, options.hosted)
  writeTransaction((conn) => {
    applyHostedNote(conn, hosted.note)
    applyHostedAcknowledgement(conn, hosted.acknowledgement)
  })
  return { note: getNote(note.id), alreadyAcknowledged: hosted.alreadyAcknowledged }
}

function noteCandidates(text: string, project?: string): NoteCandidate[] {
  const notes = listNotes({ ...(project ? { project } : {}), stale: false })
  const byId = new Map(notes.map((note) => [String(note.id), note]))
  return duplicateCandidates(
    notes.map(
      (note): TaskRow => ({
        record_id: String(note.id),
        external_id: null,
        key: String(note.id),
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
      }),
    ),
    text,
  ).map((candidate) => {
    const note = byId.get(candidate.key)!
    return { id: note.id, project: note.project, text: note.text, score: candidate.score }
  })
}

export async function mergeNote(
  targetValue: number | string,
  sourceValue: number | string,
  options: { hosted?: NoteClientOptions } = {},
): Promise<NoteRow> {
  const targetId = noteId(targetValue)
  const sourceId = noteId(sourceValue)
  if (targetId === sourceId) throw new Error('a note cannot be merged with itself')
  const target = getNote(targetId)
  const mode = writeMode(target.project, options.hosted)
  if (mode === 'local-authoritative') {
    writeTransaction((conn) => {
      const current = decode(noteRow(conn, targetId))
      const source = decode(noteRow(conn, sourceId))
      if (current.project !== source.project)
        throw new Error('notes from different projects cannot be merged')
      const lastSeen =
        current.last_seen_at > source.last_seen_at ? current.last_seen_at : source.last_seen_at
      conn
        .query(`UPDATE note SET anchors=?, sightings=?, last_seen_at=? WHERE id=?`)
        .run(
          JSON.stringify([...current.anchors, ...source.anchors]),
          current.sightings + source.sightings,
          lastSeen,
          current.id,
        )
      conn.query('DELETE FROM note WHERE id=?').run(source.id)
    })
    return getNote(targetId)
  }
  const result = await hostedMergeNotes(targetId, sourceId, options.hosted)
  writeTransaction((conn) => {
    applyHostedNote(conn, result.note)
    conn.query('DELETE FROM note WHERE id=?').run(result.deleted)
  })
  return getNote(targetId)
}

export async function createNote(
  input: {
    text: string
    cwd?: string
    area?: string
    sameAs?: number
    forceNew?: boolean
    anchor?: NoteAnchor
  },
  options: { hosted?: NoteClientOptions } = {},
): Promise<{ note: NoteRow; candidates: NoteCandidate[] }> {
  const text = input.text.trim()
  if (!text) throw new Error('note text is required')
  if (input.sameAs && input.forceNew) throw new Error('--same-as and --new are mutually exclusive')
  const anchor = input.anchor ?? deriveNoteAnchor(text, input.cwd)
  const candidates = noteCandidates(text, anchor.project)
  const mode = writeMode(anchor.project, options.hosted)
  if (input.sameAs) {
    const existing = getNote(input.sameAs)
    if (existing.project !== anchor.project)
      throw new Error('the matching note belongs to another project')
    if (mode === 'local-authoritative') {
      const at = nowIso()
      writeTransaction((conn) => {
        const row = decode(noteRow(conn, existing.id))
        if (row.project !== anchor.project)
          throw new Error('the matching note belongs to another project')
        conn
          .query(
            `UPDATE note SET anchors=?, sightings=sightings+1, last_seen_at=?, stale_at=NULL, stale_reason=NULL WHERE id=?`,
          )
          .run(JSON.stringify([...row.anchors, anchor]), at, row.id)
      })
      return { note: getNote(existing.id), candidates }
    }
    const hosted = await hostedCreateNote(
      {
        project: anchor.project,
        text,
        area: input.area?.trim() || null,
        anchor: JSON.stringify(anchor),
        sameAs: existing.id,
      },
      options.hosted,
    )
    writeTransaction((conn) => applyHostedNote(conn, hosted))
    return { note: getNote(existing.id), candidates }
  }
  if (candidates.length && !input.forceNew) return { note: null as never, candidates }
  if (mode === 'local-authoritative') {
    const at = nowIso()
    const id = writeTransaction((conn) => {
      const number = mintLocalNoteNumber(conn)
      conn
        .query(
          `INSERT INTO note (id,record_id,project,text,area,anchors,sightings,created_at,last_seen_at)
       VALUES (?,?,?,?,?,?,1,?,?)`,
        )
        .run(
          number,
          newRecordId(),
          anchor.project,
          text,
          input.area?.trim() || null,
          JSON.stringify([anchor]),
          at,
          at,
        )
      return number
    })
    return { note: getNote(id), candidates }
  }
  const hosted = await hostedCreateNote(
    {
      project: anchor.project,
      text,
      area: input.area?.trim() || null,
      anchor: JSON.stringify(anchor),
    },
    options.hosted,
  )
  writeTransaction((conn) => applyHostedNote(conn, hosted))
  return { note: getNote(hosted.number), candidates }
}

export async function promoteNote(
  value: number | string,
  options: { hosted?: NoteClientOptions } = {},
): Promise<NoteRow> {
  const note = getNote(value)
  if (note.promoted_task)
    throw new Error(`note ${note.id} is already promoted to ${note.promoted_task}`)
  const mode = writeMode(note.project, options.hosted)
  if (mode === 'local-authoritative') {
    writeTransaction((conn) => {
      const row = decode(noteRow(conn, note.id))
      if (row.promoted_task)
        throw new Error(`note ${row.id} is already promoted to ${row.promoted_task}`)
      const evidence = row.anchors
        .map(
          (anchor, index) =>
            `Sighting ${index + 1}: cwd=${anchor.cwd}; branch=${anchor.branch ?? '-'}; commit=${anchor.commit ?? '-'}; run=${anchor.run_id ?? '-'}; session=${anchor.session_id ?? '-'}`,
        )
        .join('\n')
      const task = createLocalTaskInTransaction(
        conn,
        {
          project: row.project,
          title: row.text,
          body: `${row.text}\n\nSIGHTINGS (${row.sightings})\n${evidence}`,
        },
        { skipDuplicateCheck: true },
      )
      conn
        .query(
          'UPDATE note SET promoted_task=?, promoted_task_record_id=?, last_seen_at=? WHERE id=?',
        )
        .run(task.key, task.record_id, nowIso(), row.id)
    })
    return getNote(note.id)
  }
  const hosted = await hostedPromoteNote(note.id, options.hosted)
  writeTransaction((conn) => {
    applyHostedTask(conn, hosted.task)
    applyHostedNote(conn, hosted.note)
  })
  return getNote(note.id)
}

export async function dropNote(
  value: number | string,
  reason: string,
  options: { hosted?: NoteClientOptions } = {},
): Promise<NoteRow> {
  if (!reason.trim()) throw new Error('--reason is required')
  const id = noteId(value)
  const current = getNote(id)
  const mode = writeMode(current.project, options.hosted)
  if (mode === 'local-authoritative') {
    const at = nowIso()
    writeTransaction((conn) => {
      noteRow(conn, id)
      conn
        .query(`UPDATE note SET stale_at=?, stale_reason=?, last_seen_at=? WHERE id=?`)
        .run(at, `dropped: ${reason.trim()}`, at, id)
    })
    return getNote(id)
  }
  const hosted = await hostedDropNote(id, reason.trim(), options.hosted)
  writeTransaction((conn) => applyHostedNote(conn, hosted))
  return getNote(id)
}

export type StaleResult = {
  marked: number
  deleted: number
  reasons: { id: number; reason: string }[]
}

type StaleDeps = {
  runExists(ids: number[]): Promise<Set<number>>
  git(cwd: string, ...args: string[]): string | null
  now(): Date
  hosted: NoteClientOptions
}

async function defaultRunExists(ids: number[]): Promise<Set<number>> {
  const rows = await readRunsById(ids)
  return new Set(rows.flatMap((row) => ('unknown' in row ? [] : [row.id])))
}

function vanishedReason(
  note: NoteRow,
  existingRuns: Set<number>,
  runGit: StaleDeps['git'],
): string | null {
  const registered = projects().find((project) => project.name === note.project)
  if (!registered) return `project ${note.project} is no longer registered`
  const trunk = typeof registered.settings.trunk === 'string' ? registered.settings.trunk : 'main'
  const reasons = note.anchors.map((anchor) =>
    vanishedAnchorReason(anchor, registered.path, trunk, existingRuns, runGit),
  )
  // A repeated sighting refreshes the note. Old anchors may disappear without
  // making a newer, still-grounded observation stale.
  return reasons.length && reasons.every(Boolean) ? (reasons[reasons.length - 1] ?? null) : null
}

function vanishedAnchorReason(
  anchor: NoteAnchor,
  projectPath: string,
  trunk: string,
  existingRuns: Set<number>,
  runGit: StaleDeps['git'],
): string | null {
  const fileReason = vanishedFileReason(anchor)
  if (fileReason) return fileReason
  if (anchor.run_id && !existingRuns.has(anchor.run_id)) return `run ${anchor.run_id} aged out`
  if (anchor.branch && anchor.branch !== trunk) {
    if (!runGit(projectPath, 'show-ref', '--verify', `refs/heads/${anchor.branch}`))
      return `branch ${anchor.branch} was deleted`
    if (runGit(projectPath, 'merge-base', '--is-ancestor', anchor.branch, trunk) !== null)
      return `branch ${anchor.branch} landed on ${trunk}`
  }
  if (!anchor.commit) return null
  const count = runGit(projectPath, 'rev-list', '--count', `${anchor.commit}..${trunk}`)
  return count !== null && Number(count) > 50
    ? `trunk moved ${count} commits past the anchor`
    : null
}

function vanishedFileReason(anchor: NoteAnchor): string | null {
  for (const file of anchor.files) {
    if (!existsSync(file.path)) return `${file.path}:${file.line} no longer exists`
    const content = readFileSync(file.path, 'utf8').split(/\r?\n/)[file.line - 1]
    if (content !== file.content)
      return `${file.path}:${file.line} no longer has its anchored content`
  }
  return null
}

export async function staleNotes(deps: Partial<StaleDeps> = {}): Promise<StaleResult> {
  const runGit = deps.git ?? git
  const clock = deps.now?.() ?? new Date()
  const notes = listNotes({ stale: false })
  const runIds = [
    ...new Set(
      notes.flatMap((note) =>
        note.anchors.flatMap((anchor) => (anchor.run_id ? [anchor.run_id] : [])),
      ),
    ),
  ]
  const existingRuns = await (deps.runExists ?? defaultRunExists)(runIds)
  const reasons = notes.flatMap((note) => {
    const reason = vanishedReason(note, existingRuns, runGit)
    return reason ? [{ id: note.id, reason }] : []
  })
  const at = clock.toISOString()
  const cutoff = new Date(clock.getTime() - 30 * 86_400_000).toISOString()
  const markedIds = new Set(reasons.map((row) => row.id))
  const deletedIds = db()
    .query<{ id: number; stale_at: string | null }, [string]>(
      `SELECT id,stale_at FROM note WHERE sightings=1 AND last_seen_at <= ? AND promoted_task IS NULL`,
    )
    .all(cutoff)
    .filter((row) => row.stale_at !== null || markedIds.has(row.id))
    .map((row) => row.id)
  const url = deps.hosted?.baseUrl ?? process.env.HUB_HOSTED_URL
  if (hostedWriteMode(url) !== 'hosted-configured' && readInstallBinding().bound) {
    throw new Error(
      `this install belongs to a hosted space; local writes are refused while hosting is unavailable. ${hostedUnavailableRemedy(url)}`,
    )
  }
  if (hostedWriteMode(url) !== 'hosted-configured') {
    return writeTransaction((conn) => {
      for (const item of reasons) {
        conn
          .query('UPDATE note SET stale_at=?, stale_reason=? WHERE id=? AND stale_at IS NULL')
          .run(at, item.reason, item.id)
      }
      const found = deletedIds.flatMap((id) => {
        const row = conn
          .query<{ id: number }, [number, string]>(
            `SELECT id FROM note WHERE id=? AND stale_at IS NOT NULL AND sightings=1
             AND promoted_task IS NULL AND last_seen_at <= ?`,
          )
          .get(id, cutoff)
        return row ? [row.id] : []
      })
      if (found.length < deletedIds.length)
        throw new Error(
          'local cache is behind the record; the next maintenance pass will recompute',
        )
      confirmCount(found.length, deletedIds.length, 'bulk-only')
      for (const id of found) conn.query('DELETE FROM note WHERE id=?').run(id)
      return { marked: reasons.length, deleted: found.length, reasons }
    })
  }
  const result = await hostedReapNotes(
    {
      stale: reasons.map((row) => ({ number: row.id, reason: row.reason, at })),
      deleted: deletedIds,
      confirmation: deletedIds.length,
      cutoff,
    },
    deps.hosted,
  )
  writeTransaction((conn) => {
    for (const item of reasons) {
      conn
        .query('UPDATE note SET stale_at=?, stale_reason=? WHERE id=? AND stale_at IS NULL')
        .run(at, item.reason, item.id)
    }
    for (const id of deletedIds) conn.query('DELETE FROM note WHERE id=?').run(id)
  })
  return { marked: result.marked, deleted: result.deleted, reasons }
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
    const prompt = [
      'Re-read every open note below against this checkout. Return proposals only; make no changes.',
      'For each note return: still-holds, genuine-duplicate-of-N, earned-promotion, and area, with reasons.',
      'A human will act through hub note same, drop, or promote.',
      '',
      ...notes.map((note) => `${note.id}: ${note.text}`),
    ].join('\n')
    results.push({ project: project.name, result: await dispatchNoteCurator(project.path, prompt) })
  }
  return results
}
