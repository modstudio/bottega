import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import {
  acknowledgeNote,
  createNote,
  deriveNoteAnchor,
  dropNote,
  getNote,
  listActionableNotes,
  listNotes,
  mergeNote,
  type NoteAnchor,
  promoteNote,
  staleNotes,
} from './note.ts'

const scratch = mkdtempSync(join(tmpdir(), 'hub-note-'))
beforeAll(resetFixtureStore)
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('suggestion notes', () => {
  test('orch note files through hub with cwd and session anchors', () => {
    const text = `CLI suggestion ${crypto.randomUUID()}`
    const prior = process.env.CLAUDE_CODE_SESSION_ID
    try {
      process.env.CLAUDE_CODE_SESSION_ID = 'note-cli-session'
      const note = createNote({ text, cwd: '/fixtures/repos/workshop', forceNew: true }).note
      expect(note).toMatchObject({ project: 'workshop', text })
      expect(note.anchors[0]).toMatchObject({
        cwd: '/fixtures/repos/workshop',
        session_id: 'note-cli-session',
      })
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = prior
    }
  })

  test('orch note without a duplicate choice returns candidates and files nothing', () => {
    const unique = crypto.randomUUID()
    const first = createNote({
      text: `Collector ${unique} loses active run intervals`,
      cwd: '/fixtures/repos/workshop',
      forceNew: true,
    }).note
    const before = listNotes().length
    const offered = createNote({
      text: `Collector ${unique} loses the active run interval`,
      cwd: '/fixtures/repos/workshop',
    })
    expect(offered.candidates[0]?.id).toBe(first.id)
    expect(listNotes()).toHaveLength(before)
  })

  test('create derives cwd, file content, run and session anchors', () => {
    const file = join(scratch, 'anchor.ts')
    writeFileSync(file, 'first\nanchored line\n')
    const anchor = deriveNoteAnchor(`inspect ${file}:2`, '/fixtures/repos/workshop', {
      ORCH_RUN_ID: '42',
      CLAUDE_CODE_SESSION_ID: 'session-42',
    } as NodeJS.ProcessEnv)
    expect(anchor).toMatchObject({
      project: 'workshop',
      cwd: '/fixtures/repos/workshop',
      run_id: 42,
      session_id: 'session-42',
    })
    expect(anchor.files).toEqual([{ path: file, line: 2, content: 'anchored line' }])
  })

  test('a write offers duplicate notes until the caller chooses', () => {
    const first = createNote({
      text: 'The collector loses active run intervals',
      cwd: '/fixtures/repos/workshop',
      forceNew: true,
    }).note
    const offered = createNote({
      text: 'Collector loses the active run interval',
      cwd: '/fixtures/repos/workshop',
    })
    expect(offered.note).toBeFalsy()
    expect(offered.candidates[0]?.id).toBe(first.id)
  })

  test('same preserves sightings and drop records why', () => {
    const one = createNote({
      text: 'First merge observation',
      cwd: '/fixtures/repos/workshop',
      forceNew: true,
    }).note
    const two = createNote({
      text: 'Second merge observation',
      cwd: '/fixtures/repos/workshop',
      forceNew: true,
    }).note
    expect(mergeNote(one.id, two.id).sightings).toBe(2)
    expect(() => getNote(two.id)).toThrow(`no note ${two.id}`)

    expect(dropNote(one.id, 'superseded').stale_reason).toBe('dropped: superseded')
  })

  test('actionable notes exclude promoted and dropped rows', () => {
    const session = `actionable-${crypto.randomUUID()}`
    const make = (text: string) =>
      createNote({ text, cwd: '/fixtures/repos/workshop', forceNew: true }).note
    const open = make('Open curator observation')
    const promoted = make('Promoted curator observation')
    const dropped = make('Dropped curator observation')
    const anchor = JSON.stringify([{ ...open.anchors[0], session_id: session }])
    writeTransaction((conn) => {
      const update = conn.query('UPDATE note SET anchors=? WHERE id=?')
      for (const note of [open, promoted, dropped]) update.run(anchor, note.id)
    })
    promoteNote(promoted.id)
    dropNote(dropped.id, 'resolved')
    expect(listActionableNotes({ session }).map((note) => note.id)).toEqual([open.id])
  })

  test('keep acknowledges one session idempotently and a further sighting clears it', () => {
    const session = `keep-${crypto.randomUUID()}`
    const otherSession = `other-${crypto.randomUUID()}`
    const note = createNote({
      text: `Keep observation ${crypto.randomUUID()}`,
      cwd: '/fixtures/repos/workshop',
      forceNew: true,
    }).note
    const anchor = { ...note.anchors[0]!, session_id: session }
    const otherAnchor = { ...anchor, session_id: otherSession }
    writeTransaction((conn) =>
      conn
        .query('UPDATE note SET anchors=?, sightings=2 WHERE id=?')
        .run(JSON.stringify([anchor, otherAnchor]), note.id),
    )

    expect(acknowledgeNote(note.id, session).alreadyAcknowledged).toBe(false)
    expect(acknowledgeNote(note.id, session).alreadyAcknowledged).toBe(true)
    expect(listNotes({ session }).map((row) => row.id)).not.toContain(note.id)
    expect(listNotes({ session: otherSession }).map((row) => row.id)).toContain(note.id)
    expect(listNotes({ session: [otherSession, session] }).map((row) => row.id)).not.toContain(
      note.id,
    )
    expect(listNotes({ session, kept: true }).map((row) => row.id)).toContain(note.id)

    writeTransaction((conn) =>
      conn
        .query('UPDATE note SET anchors=?, sightings=sightings+1, last_seen_at=? WHERE id=?')
        .run(JSON.stringify([anchor, otherAnchor, anchor]), new Date().toISOString(), note.id),
    )
    expect(listNotes({ session }).map((row) => row.id)).toContain(note.id)
    expect(listNotes({ session: otherSession }).map((row) => row.id)).toContain(note.id)
    expect(listNotes({ session, kept: true }).map((row) => row.id)).not.toContain(note.id)
  })

  test('stale maintenance recognizes file, run, branch and commit anchors', async () => {
    const file = join(scratch, 'changed.ts')
    writeFileSync(file, 'new\n')
    const base: NoteAnchor = {
      cwd: '/fixtures/repos/workshop',
      project: 'workshop',
      files: [],
      run_id: null,
      branch: null,
      commit: null,
      session_id: null,
    }
    const anchors = [
      { ...base, files: [{ path: file, line: 1, content: 'old' }] },
      { ...base, run_id: 999 },
      { ...base, branch: 'deleted-branch' },
      { ...base, commit: 'old-commit' },
    ]
    const ids = writeTransaction((conn) =>
      anchors.map((anchor, index) =>
        Number(
          conn
            .query(
              `INSERT INTO note(project,text,anchors,sightings,created_at,last_seen_at) VALUES ('workshop',?,?,2,?,?)`,
            )
            .run(
              `stale fixture ${index}`,
              JSON.stringify([anchor]),
              new Date().toISOString(),
              new Date().toISOString(),
            ).lastInsertRowid,
        ),
      ),
    )
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
    const anchor = JSON.stringify([
      {
        cwd: '/fixtures/repos/workshop',
        project: 'workshop',
        files: [],
        run_id: 404,
        branch: null,
        commit: null,
        session_id: null,
      },
    ])
    const add = (sightings: number, promoted: string | null, seen = old) =>
      writeTransaction((conn) =>
        Number(
          conn
            .query(
              `INSERT INTO note(project,text,anchors,sightings,created_at,last_seen_at,stale_at,stale_reason,promoted_task)
       VALUES ('workshop',?,?,?, ?,?,'2026-07-02T00:00:00.000Z','gone',?)`,
            )
            .run(`reap ${Math.random()}`, anchor, sightings, old, seen, promoted).lastInsertRowid,
        ),
      )
    const doomed = add(1, null)
    const repeated = add(2, null)
    const recent = add(1, null, '2026-09-01T00:00:00.000Z')
    const result = await staleNotes({
      runExists: async () => new Set(),
      now: () => new Date('2026-09-07T12:00:00.000Z'),
    })
    expect(result.deleted).toBeGreaterThanOrEqual(1)
    expect(() => getNote(doomed)).toThrow(`no note ${doomed}`)
    expect(getNote(repeated).id).toBe(repeated)
    expect(getNote(recent).id).toBe(recent)
  })
})
