import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { projectOf } from './attribute.ts'
import { db, writeTransaction } from './db.ts'
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
import { dispatchNoteCurator, readRunsById } from './orch.ts'
import { projects } from './projects.ts'
import { duplicateCandidates, type TaskRow } from './task.ts'
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

export function deriveNoteAnchor(text: string, cwd = process.cwd(), env = process.env): NoteAnchor {
  const project = projectOf(cwd)
  if (!project) throw new Error(`cannot file note: no registered project contains ${cwd}`)
  const root = git(cwd, 'rev-parse', '--show-toplevel') || cwd
  const files = [...text.matchAll(/(?:^|[\s`(])([^\s`():]+):(\d+)\b/g)].flatMap((match) => {
    const line = Number(match[2])
    const path = isAbsolute(match[1]!) ? match[1]! : resolve(root, match[1]!)
    if (!existsSync(path)) return []
    const content = readFileSync(path, 'utf8').split(/\r?\n/)[line - 1]
    return content === undefined ? [] : [{ path, line, content }]
  })
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
        record_id: null,
        key: String(note.id),
        project: note.project,
        title: note.text,
        status: null,
        status_category: null,
        parent_key: null,
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
  },
  options: { hosted?: NoteClientOptions } = {},
): Promise<{ note: NoteRow; candidates: NoteCandidate[] }> {
  const text = input.text.trim()
  if (!text) throw new Error('note text is required')
  if (input.sameAs && input.forceNew) throw new Error('--same-as and --new are mutually exclusive')
  const anchor = deriveNoteAnchor(text, input.cwd)
  const candidates = noteCandidates(text, anchor.project)
  if (input.sameAs) {
    const existing = getNote(input.sameAs)
    if (existing.project !== anchor.project)
      throw new Error('the matching note belongs to another project')
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
  const reasons = note.anchors.map((anchor): string | null => {
    for (const file of anchor.files) {
      if (!existsSync(file.path)) return `${file.path}:${file.line} no longer exists`
      const content = readFileSync(file.path, 'utf8').split(/\r?\n/)[file.line - 1]
      if (content !== file.content)
        return `${file.path}:${file.line} no longer has its anchored content`
    }
    if (anchor.run_id && !existingRuns.has(anchor.run_id)) return `run ${anchor.run_id} aged out`
    if (anchor.branch && anchor.branch !== trunk) {
      if (!runGit(registered.path, 'show-ref', '--verify', `refs/heads/${anchor.branch}`)) {
        return `branch ${anchor.branch} was deleted`
      }
      if (runGit(registered.path, 'merge-base', '--is-ancestor', anchor.branch, trunk) !== null) {
        return `branch ${anchor.branch} landed on ${trunk}`
      }
    }
    if (anchor.commit) {
      const count = runGit(registered.path, 'rev-list', '--count', `${anchor.commit}..${trunk}`)
      if (count !== null && Number(count) > 50)
        return `trunk moved ${count} commits past the anchor`
    }
    return null
  })
  // A repeated sighting refreshes the note. Old anchors may disappear without
  // making a newer, still-grounded observation stale.
  return reasons.length && reasons.every(Boolean) ? (reasons[reasons.length - 1] ?? null) : null
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
  const result = await hostedReapNotes(
    {
      stale: reasons.map((row) => ({ number: row.id, reason: row.reason, at })),
      deleted: deletedIds,
      confirmation: deletedIds.length,
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
