import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { db, nowIso } from './db.ts'
import { projectOf } from './attribute.ts'
import { projects } from './projects.ts'
import { createTask, duplicateCandidates, type TaskRow } from './task.ts'
import { dispatchNoteCurator, readRunsById } from './orch.ts'

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
  if (!projects().some((candidate) => candidate.name === name)) throw new Error(`unknown project '${name}'`)
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
    cwd, project, files,
    run_id: Number.isSafeInteger(run) && run > 0 ? run : null,
    branch: git(cwd, 'branch', '--show-current') || null,
    commit: git(cwd, 'rev-parse', 'HEAD') || null,
    session_id: env.CLAUDE_CODE_SESSION_ID ?? env.CODEX_THREAD_ID ?? null,
  }
}

export function listNotes(filters: { project?: string; stale?: boolean } = {}): NoteRow[] {
  const clauses: string[] = []
  const values: (string | number)[] = []
  if (filters.project) { registeredProject(filters.project); clauses.push('project = ?'); values.push(filters.project) }
  if (filters.stale !== undefined) clauses.push(filters.stale ? 'stale_at IS NOT NULL' : 'stale_at IS NULL')
  const rows = db().query<Omit<NoteRow, 'anchors'> & { anchors: string }, (string | number)[]>(
    `SELECT * FROM note ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY last_seen_at DESC, id DESC`,
  ).all(...values)
  return rows.map(decode)
}

export function getNote(value: number | string): NoteRow {
  const id = noteId(value)
  const row = db().query<Omit<NoteRow, 'anchors'> & { anchors: string }, [number]>(
    'SELECT * FROM note WHERE id = ?',
  ).get(id)
  if (!row) throw new Error(`no note ${id}`)
  return decode(row)
}

export function noteCandidates(text: string, project?: string): NoteCandidate[] {
  const notes = listNotes({ ...(project ? { project } : {}), stale: false })
  const byId = new Map(notes.map((note) => [String(note.id), note]))
  return duplicateCandidates(notes.map((note): TaskRow => ({
    key: String(note.id), project: note.project, title: note.text, status: null,
    status_category: null, parent_key: null, body: null, assignee: null,
    opened_at: note.created_at, closed_at: null, updated_at: note.last_seen_at,
    source: 'local', first_seen: note.created_at, last_seen: note.last_seen_at,
  })), text).map((candidate) => {
    const note = byId.get(candidate.key)!
    return { id: note.id, project: note.project, text: note.text, score: candidate.score }
  })
}

export function mergeNote(targetValue: number | string, sourceValue: number | string): NoteRow {
  const targetId = noteId(targetValue)
  const sourceId = noteId(sourceValue)
  if (targetId === sourceId) throw new Error('a note cannot be merged with itself')
  const d = db()
  d.transaction(() => {
    const target = getNote(targetId)
    const source = getNote(sourceId)
    if (target.project !== source.project) throw new Error('notes from different projects cannot be merged')
    d.query(`UPDATE note SET anchors=?, sightings=?, last_seen_at=? WHERE id=?`).run(
      JSON.stringify([...target.anchors, ...source.anchors]), target.sightings + source.sightings,
      target.last_seen_at > source.last_seen_at ? target.last_seen_at : source.last_seen_at, targetId,
    )
    d.query('DELETE FROM note WHERE id=?').run(sourceId)
  }).immediate()
  return getNote(targetId)
}

export function createNote(input: {
  text: string; cwd?: string; area?: string; sameAs?: number; forceNew?: boolean
}): { note: NoteRow; candidates: NoteCandidate[] } {
  const text = input.text.trim()
  if (!text) throw new Error('note text is required')
  if (input.sameAs && input.forceNew) throw new Error('--same-as and --new are mutually exclusive')
  const anchor = deriveNoteAnchor(text, input.cwd)
  const candidates = noteCandidates(text, anchor.project)
  if (input.sameAs) {
    const existing = getNote(input.sameAs)
    if (existing.project !== anchor.project) throw new Error('the matching note belongs to another project')
    const at = nowIso()
    db().query(`UPDATE note SET anchors=?, sightings=sightings+1, last_seen_at=?, stale_at=NULL, stale_reason=NULL WHERE id=?`).run(
      JSON.stringify([...existing.anchors, anchor]), at, existing.id,
    )
    return { note: getNote(existing.id), candidates }
  }
  if (candidates.length && !input.forceNew) return { note: null as never, candidates }
  const at = nowIso()
  const result = db().query(
    `INSERT INTO note (project,text,area,anchors,sightings,created_at,last_seen_at)
     VALUES (?,?,?,?,1,?,?)`,
  ).run(anchor.project, text, input.area?.trim() || null, JSON.stringify([anchor]), at, at)
  return { note: getNote(Number(result.lastInsertRowid)), candidates }
}

export function promoteNote(value: number | string): NoteRow {
  const note = getNote(value)
  if (note.promoted_task) throw new Error(`note ${note.id} is already promoted to ${note.promoted_task}`)
  const evidence = note.anchors.map((anchor, index) =>
    `Sighting ${index + 1}: cwd=${anchor.cwd}; branch=${anchor.branch ?? '-'}; commit=${anchor.commit ?? '-'}; run=${anchor.run_id ?? '-'}; session=${anchor.session_id ?? '-'}`,
  ).join('\n')
  const task = createTask({ project: note.project, title: note.text, body: `${note.text}\n\nSIGHTINGS (${note.sightings})\n${evidence}` })
  db().query('UPDATE note SET promoted_task=?, last_seen_at=? WHERE id=?').run(task.key, nowIso(), note.id)
  return getNote(note.id)
}

export function dropNote(value: number | string, reason: string): NoteRow {
  if (!reason.trim()) throw new Error('--reason is required')
  const id = noteId(value)
  db().query('UPDATE note SET stale_at=?, stale_reason=?, last_seen_at=? WHERE id=?').run(
    nowIso(), `dropped: ${reason.trim()}`, nowIso(), id,
  )
  return getNote(id)
}

export type StaleResult = { marked: number; deleted: number; reasons: { id: number; reason: string }[] }

type StaleDeps = {
  runExists(ids: number[]): Promise<Set<number>>
  git(cwd: string, ...args: string[]): string | null
  now(): Date
}

async function defaultRunExists(ids: number[]): Promise<Set<number>> {
  const rows = await readRunsById(ids)
  return new Set(rows.flatMap((row) => 'unknown' in row ? [] : [row.id]))
}

function vanishedReason(note: NoteRow, existingRuns: Set<number>, runGit: StaleDeps['git']): string | null {
  const registered = projects().find((project) => project.name === note.project)
  if (!registered) return `project ${note.project} is no longer registered`
  const trunk = typeof registered.settings.trunk === 'string' ? registered.settings.trunk : 'main'
  const reasons = note.anchors.map((anchor): string | null => {
    for (const file of anchor.files) {
      if (!existsSync(file.path)) return `${file.path}:${file.line} no longer exists`
      const content = readFileSync(file.path, 'utf8').split(/\r?\n/)[file.line - 1]
      if (content !== file.content) return `${file.path}:${file.line} no longer has its anchored content`
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
      if (count !== null && Number(count) > 50) return `trunk moved ${count} commits past the anchor`
    }
    return null
  })
  // A repeated sighting refreshes the note. Old anchors may disappear without
  // making a newer, still-grounded observation stale.
  return reasons.length && reasons.every(Boolean) ? reasons[reasons.length - 1] ?? null : null
}

export async function staleNotes(deps: Partial<StaleDeps> = {}): Promise<StaleResult> {
  const runGit = deps.git ?? git
  const clock = deps.now?.() ?? new Date()
  const notes = listNotes({ stale: false })
  const runIds = [...new Set(notes.flatMap((note) => note.anchors.flatMap((anchor) => anchor.run_id ? [anchor.run_id] : [])))]
  const existingRuns = await (deps.runExists ?? defaultRunExists)(runIds)
  const reasons = notes.flatMap((note) => {
    const reason = vanishedReason(note, existingRuns, runGit)
    return reason ? [{ id: note.id, reason }] : []
  })
  const at = clock.toISOString()
  const cutoff = new Date(clock.getTime() - 30 * 86_400_000).toISOString()
  const d = db()
  let deleted = 0
  d.transaction(() => {
    for (const item of reasons) {
      d.query('UPDATE note SET stale_at=?, stale_reason=? WHERE id=? AND stale_at IS NULL').run(at, item.reason, item.id)
    }
    const result = d.query(
      `DELETE FROM note
        WHERE stale_at IS NOT NULL AND sightings=1 AND last_seen_at <= ? AND promoted_task IS NULL`,
    ).run(cutoff)
    deleted = result.changes
  }).immediate()
  return { marked: reasons.length, deleted, reasons }
}

export function curatorEnabled(): boolean {
  const row = db().query<{ value: string }, []>("SELECT value FROM setting WHERE key='note.curator.enabled'").get()
  return row?.value === 'true'
}

export function setCuratorEnabled(enabled: boolean): boolean {
  db().query(
    "INSERT INTO setting(key,value) VALUES ('note.curator.enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(String(enabled))
  return enabled
}

export async function curateNotes(scheduled = false): Promise<{ project: string; result: string }[]> {
  if (scheduled && !curatorEnabled()) return []
  const results: { project: string; result: string }[] = []
  for (const project of projects()) {
    const notes = listNotes({ project: project.name, stale: false })
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
