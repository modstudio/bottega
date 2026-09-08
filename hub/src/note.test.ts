import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { db } from './db.ts'
import { bootstrapFixtureStore } from './db.ts'
import {
  createNote, deriveNoteAnchor, dropNote, getNote, mergeNote, staleNotes,
  listActionableNotes, promoteNote,
  type NoteAnchor,
} from './note.ts'

const scratch = mkdtempSync(join(tmpdir(), 'hub-note-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('suggestion notes', () => {
  test('note curate --help prints usage without running curate', () => {
    const hub = new URL('./cli.ts', import.meta.url).pathname
    const result = Bun.spawnSync([process.execPath, hub, 'note', 'curate', '--help'], {
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('hub note curate')
    expect(result.stderr.toString()).not.toContain('curator')
  })

  test('bare help is a subcommand only, never the note payload', () => {
    const path = join(scratch, 'note-help.db')
    bootstrapFixtureStore(path)
    const hub = new URL('./cli.ts', import.meta.url).pathname
    const env = {
      ...process.env, HUB_DB: path,
      HUB_ORCH: new URL('../test/project-register.ts', import.meta.url).pathname,
    }
    const payload = Bun.spawnSync([process.execPath, hub, 'note', 'new', 'help', '--new'], {
      env, stdout: 'pipe', stderr: 'pipe',
    })
    expect(payload.exitCode, payload.stderr.toString()).toBe(0)
    const stored = new Database(path, { readonly: true })
    expect(stored.query<{ text: string }, []>('SELECT text FROM note').get()).toEqual({ text: 'help' })
    stored.close()
    const command = Bun.spawnSync([process.execPath, hub, 'note', 'help'], {
      env, stdout: 'pipe', stderr: 'pipe',
    })
    expect(command.exitCode).toBe(0)
    expect(command.stdout.toString()).toContain('hub note new')
  })

  test('create derives cwd, file content, run and session anchors', () => {
    const file = join(scratch, 'anchor.ts')
    writeFileSync(file, 'first\nanchored line\n')
    const anchor = deriveNoteAnchor(`inspect ${file}:2`, '/fixtures/repos/workshop', {
      ORCH_RUN_ID: '42', CLAUDE_CODE_SESSION_ID: 'session-42',
    } as NodeJS.ProcessEnv)
    expect(anchor).toMatchObject({ project: 'workshop', cwd: '/fixtures/repos/workshop', run_id: 42, session_id: 'session-42' })
    expect(anchor.files).toEqual([{ path: file, line: 2, content: 'anchored line' }])
  })

  test('a write offers duplicate notes until the caller chooses', () => {
    const first = createNote({ text: 'The collector loses active run intervals', cwd: '/fixtures/repos/workshop', forceNew: true }).note
    const offered = createNote({ text: 'Collector loses the active run interval', cwd: '/fixtures/repos/workshop' })
    expect(offered.note).toBeFalsy()
    expect(offered.candidates[0]?.id).toBe(first.id)
  })

  test('same preserves sightings and drop records why', () => {
    const one = createNote({ text: 'First merge observation', cwd: '/fixtures/repos/workshop', forceNew: true }).note
    const two = createNote({ text: 'Second merge observation', cwd: '/fixtures/repos/workshop', forceNew: true }).note
    expect(mergeNote(one.id, two.id).sightings).toBe(2)
    expect(() => getNote(two.id)).toThrow(`no note ${two.id}`)

    expect(dropNote(one.id, 'superseded').stale_reason).toBe('dropped: superseded')
  })

  test('actionable notes exclude promoted and dropped rows', () => {
    const session = `actionable-${crypto.randomUUID()}`
    const make = (text: string) => createNote({ text, cwd: '/fixtures/repos/workshop', forceNew: true }).note
    const open = make('Open curator observation')
    const promoted = make('Promoted curator observation')
    const dropped = make('Dropped curator observation')
    const anchor = JSON.stringify([{ ...open.anchors[0], session_id: session }])
    for (const note of [open, promoted, dropped]) db().query('UPDATE note SET anchors=? WHERE id=?').run(anchor, note.id)
    promoteNote(promoted.id)
    dropNote(dropped.id, 'resolved')
    expect(listActionableNotes({ session }).map((note) => note.id)).toEqual([open.id])
  })

  test('reserved text requires the note new grammar', () => {
    const cli = new URL('./cli.ts', import.meta.url).pathname
    const result = Bun.spawnSync([process.execPath, cli, 'note', 'list', '--new'], {
      env: process.env, stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('hub note new "list"')
  })

  test('stale maintenance recognizes file, run, branch and commit anchors', async () => {
    const file = join(scratch, 'changed.ts')
    writeFileSync(file, 'new\n')
    const base: NoteAnchor = { cwd: '/fixtures/repos/workshop', project: 'workshop', files: [], run_id: null, branch: null, commit: null, session_id: null }
    const anchors = [
      { ...base, files: [{ path: file, line: 1, content: 'old' }] },
      { ...base, run_id: 999 },
      { ...base, branch: 'deleted-branch' },
      { ...base, commit: 'old-commit' },
    ]
    const ids = anchors.map((anchor, index) => Number(db().query(
      `INSERT INTO note(project,text,anchors,sightings,created_at,last_seen_at) VALUES ('workshop',?,?,2,?,?)`,
    ).run(`stale fixture ${index}`, JSON.stringify([anchor]), new Date().toISOString(), new Date().toISOString()).lastInsertRowid))
    const result = await staleNotes({
      runExists: async () => new Set(),
      git: (_cwd, command, ...args) => {
        if (command === 'show-ref') return null
        if (command === 'rev-list' && args.includes('old-commit..main')) return '51'
        return null
      },
      now: () => new Date('2026-09-07T12:00:00.000Z'),
    })
    const byId = new Map(result.reasons.map((row) => [row.id, row.reason]))
    expect(ids.map((id) => byId.get(id))).toEqual([
      `${file}:1 no longer has its anchored content`,
      'run 999 aged out',
      'branch deleted-branch was deleted',
      'trunk moved 51 commits past the anchor',
    ])
  })

  test('stale maintenance deletes only old singleton unpromoted notes', async () => {
    const old = '2026-07-01T00:00:00.000Z'
    const anchor = JSON.stringify([{ cwd: '/fixtures/repos/workshop', project: 'workshop', files: [], run_id: 404, branch: null, commit: null, session_id: null }])
    const add = (sightings: number, promoted: string | null, seen = old) => Number(db().query(
      `INSERT INTO note(project,text,anchors,sightings,created_at,last_seen_at,stale_at,stale_reason,promoted_task)
       VALUES ('workshop',?,?,?, ?,?,'2026-07-02T00:00:00.000Z','gone',?)`,
    ).run(`reap ${Math.random()}`, anchor, sightings, old, seen, promoted).lastInsertRowid)
    const doomed = add(1, null)
    const repeated = add(2, null)
    const recent = add(1, null, '2026-09-01T00:00:00.000Z')
    const result = await staleNotes({ runExists: async () => new Set(), now: () => new Date('2026-09-07T12:00:00.000Z') })
    expect(result.deleted).toBeGreaterThanOrEqual(1)
    expect(() => getNote(doomed)).toThrow(`no note ${doomed}`)
    expect(getNote(repeated).id).toBe(repeated)
    expect(getNote(recent).id).toBe(recent)
  })

  test('promote uses the create gate and stale cleanup preserves promoted notes', () => {
    const path = join(scratch, 'promote.db')
    bootstrapFixtureStore(path)
    const isolated = new Database(path)
    const at = '2026-07-01T00:00:00.000Z'
    const id = Number(isolated.query(
      `INSERT INTO note(project,text,anchors,sightings,created_at,last_seen_at)
       VALUES ('workshop','isolated promotion','[]',1,?,?)`,
    ).run(at, at).lastInsertRowid)
    isolated.close()
    const cli = new URL('./cli.ts', import.meta.url).pathname
    const env = { ...process.env, HUB_DB: path, HUB_ORCH: new URL('../test/project-register.ts', import.meta.url).pathname }
    const promoted = Bun.spawnSync([process.execPath, cli, 'note', 'promote', String(id)], { env, stdout: 'pipe', stderr: 'pipe' })
    expect(promoted.exitCode, promoted.stderr.toString()).toBe(0)
    expect(promoted.stdout.toString().trim()).toMatch(/^LOC-/)
    const marked = new Database(path)
    marked.query("UPDATE note SET stale_at='2026-07-02T00:00:00.000Z', stale_reason='gone', last_seen_at=? WHERE id=?").run(at, id)
    marked.close()
    const swept = Bun.spawnSync([process.execPath, cli, 'note', 'stale'], { env, stdout: 'pipe', stderr: 'pipe' })
    expect(swept.exitCode, swept.stderr.toString()).toBe(0)
    const checked = new Database(path)
    expect(checked.query<{ promoted_task: string }, [number]>('SELECT promoted_task FROM note WHERE id=?').get(id)?.promoted_task).toMatch(/^LOC-/)
    checked.close()
  })
})
