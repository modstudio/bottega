import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { setDoc } from '../../test/fixtures/docs.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { encodeContextItem } from '../doc/context-item-codec.ts'
import { CONTEXT_FACTS_PORTS_KEY, type ContextFactsPorts } from '../doc/context-write-adapter.ts'
import { getDoc } from '../doc/docs.ts'
import { upsertProject } from '../project/projects.ts'
import type { SessionCloseOutReport } from '../session/session-close-out.ts'
import { markSessionCloseOutSwept } from '../session/session-close-out-store.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { sweepRuns } from './cleanup-sweep.ts'
import { sweepSessionContext } from './cleanup-sweep-context.ts'
import { sweepSessionCloseOutRecords } from './cleanup-sweep-session-close-out.ts'

afterEach(() => {
  mock.restore()
})

function closeOutReport(session: string, clean = true): SessionCloseOutReport {
  return {
    session,
    dryRun: false,
    resume: false,
    owned: {
      runs: [],
      branches: [],
      claims: [],
      landings: [],
      reviews: [],
      cursors: [],
      contextItems: [],
    },
    mechanical: [],
    kept: [],
    parked: [],
    process: clean
      ? []
      : [{ item: 'held work', reason: 'still live', evidence: 'fixture', remedy: 'finish it' }],
    warnings: [],
    errors: clean ? [] : [{ item: 'release', detail: 'fixture failure', retry: 'retry close-out' }],
    heldTrees: [],
    verdict: { clean, residue: clean ? 0 : 2 },
    recommendation: clean ? 'clear' : 'brief',
  }
}

test('closed session sweep acts only on current clean rows and retains resumed or unclean replays', async () => {
  const closed = newRecordId()
  const resumed = newRecordId()
  const unclean = newRecordId()
  const raced = newRecordId()
  const alreadySwept = newRecordId()
  const superseded = newRecordId()
  const closedAt = '2026-11-09T12:00:00.000Z'
  const database = db()
  const insert = database.query(
    `INSERT INTO session_close_out
     (record_id,session_id,closed_at,clean,recommendation,mechanical_count,process_count,error_count,warning_count)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  )
  insert.run(newRecordId(), closed, closedAt, 1, 'clear', 1, 0, 0, 0)
  insert.run(newRecordId(), resumed, closedAt, 1, 'clear', 1, 0, 0, 0)
  insert.run(newRecordId(), unclean, closedAt, 1, 'clear', 1, 0, 0, 0)
  insert.run(newRecordId(), raced, closedAt, 1, 'clear', 1, 0, 0, 0)
  const alreadySweptRecord = newRecordId()
  insert.run(alreadySweptRecord, alreadySwept, closedAt, 1, 'clear', 1, 0, 0, 0)
  const oldSupersededRecord = newRecordId()
  insert.run(oldSupersededRecord, superseded, '2026-09-01T00:00:00.000Z', 1, 'clear', 1, 0, 0, 0)
  insert.run(newRecordId(), superseded, '2026-11-08T00:00:00.000Z', 0, 'brief', 0, 1, 0, 0)
  database
    .query('INSERT INTO session_seen(session_id,last_seen) VALUES (?,?),(?,?),(?,?),(?,?),(?,?)')
    .run(
      closed,
      closedAt,
      resumed,
      '2026-11-09T12:01:00.000Z',
      unclean,
      closedAt,
      raced,
      closedAt,
      alreadySwept,
      closedAt,
    )
  const lines: string[] = []

  expect(
    await sweepSessionCloseOutRecords({
      enabled: true,
      dryRun: false,
      database,
      now: Date.parse('2026-11-09T12:02:00.000Z'),
      presentation: presentation(lines, () => {}),
      adapters: {
        release: async (session) => {
          if (session === raced)
            database
              .query('UPDATE session_seen SET last_seen=? WHERE session_id=?')
              .run('2026-11-09T12:01:30.000Z', raced)
          if (session === alreadySwept)
            markSessionCloseOutSwept(alreadySweptRecord, '2026-11-09T12:01:45.000Z', database)
          return closeOutReport(session, session !== unclean)
        },
        releaseClaims: () => 0,
      },
    }),
  ).toBe(true)

  expect(database.query('SELECT session_id FROM session_seen').all()).toEqual(
    expect.arrayContaining([
      { session_id: resumed },
      { session_id: unclean },
      { session_id: raced },
      { session_id: alreadySwept },
    ]),
  )
  expect(database.query('SELECT COUNT(*) count FROM session_seen').get()).toEqual({ count: 4 })
  expect(database.query('SELECT session_id,swept_at FROM session_close_out').all()).toEqual(
    expect.arrayContaining([
      { session_id: closed, swept_at: '2026-11-09T12:02:00.000Z' },
      { session_id: alreadySwept, swept_at: '2026-11-09T12:01:45.000Z' },
      { session_id: raced, swept_at: null },
      { session_id: resumed, swept_at: null },
      { session_id: superseded, swept_at: null },
      { session_id: unclean, swept_at: null },
    ]),
  )
  expect(database.query('SELECT COUNT(*) count FROM session_close_out').get()).toEqual({ count: 6 })
  expect(
    database
      .query('SELECT record_id FROM session_close_out WHERE record_id=?')
      .get(oldSupersededRecord),
  ).toBeNull()
  expect(lines).toContain(
    `closed session ${unclean} remains: held work: still live; evidence: fixture; remedy: finish it`,
  )
  expect(lines).toContain(
    `closed session ${unclean} error: release: fixture failure; retry: retry close-out`,
  )
  expect(lines).toContain(`closed session ${alreadySwept} was already swept`)
  expect(lines).not.toContain(`swept closed session ${alreadySwept}`)
})

test('session context sweep logs and drops each item for a gone owner', async () => {
  const session = newRecordId()
  ;(globalThis as typeof globalThis & { [CONTEXT_FACTS_PORTS_KEY]?: ContextFactsPorts })[
    CONTEXT_FACTS_PORTS_KEY
  ] = { tasks: async () => [], task: async () => null, pointer: async () => null }
  const previousSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = session
  for (const slug of ['one', 'two'])
    await setDoc({
      scope: 'context',
      subject: `session:${session}`,
      slug,
      title: slug,
      body: encodeContextItem({ kind: 'fact', source: 'test', body: slug }),
    })
  if (previousSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = previousSession
  db()
    .query('UPDATE doc SET created_at=?,updated_at=? WHERE scope=? AND subject=?')
    .run('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 'context', `session:${session}`)
  const lines: string[] = []

  expect(
    await sweepSessionContext({
      enabled: true,
      dryRun: false,
      database: db(),
      presentation: presentation(lines, () => {}),
    }),
  ).toBe(false)

  expect(lines).toEqual([
    `dropped context session:${session}/one (fact)`,
    `dropped context session:${session}/two (fact)`,
  ])
  expect(getDoc('context', `session:${session}`, 'one')).toBeNull()
  expect(getDoc('context', `session:${session}`, 'two')).toBeNull()
})

test.each(['session_seen', 'holder write'])(
  'session context sweep keeps items for a live owner by %s',
  async (activity) => {
    const session = newRecordId()
    const prior = process.env.CLAUDE_CODE_SESSION_ID
    process.env.CLAUDE_CODE_SESSION_ID = session
    await setDoc({
      scope: 'context',
      subject: `session:${session}`,
      slug: 'live',
      title: 'live',
      body: encodeContextItem({ kind: 'fact', source: 'test', body: 'still live' }),
    })
    if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = prior
    if (activity === 'session_seen') {
      db()
        .query('UPDATE doc SET updated_at=? WHERE scope=? AND subject=?')
        .run('2020-01-01T00:00:00.000Z', 'context', `session:${session}`)
      db()
        .query('INSERT INTO session_seen(session_id,last_seen) VALUES (?,?)')
        .run(session, new Date().toISOString())
    }

    await sweepSessionContext({
      enabled: true,
      dryRun: false,
      database: db(),
      presentation: presentation([], () => {}),
    })

    expect(getDoc('context', `session:${session}`, 'live')).not.toBeNull()
  },
)

test('session context sweep keeps items while the author has an unconsumed resume brief', async () => {
  const session = newRecordId()
  const project = `sweep-resume-${newRecordId()}`
  upsertProject({ recordId: newRecordId(), name: project, path: `/w/${project}`, settings: {} })
  const prior = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = session
  await setDoc({
    scope: 'context',
    subject: `session:${session}`,
    slug: 'kept-for-resume',
    title: 'kept-for-resume',
    body: encodeContextItem({ kind: 'fact', source: 'test', body: 'successor needs this' }),
  })
  await setDoc({
    scope: 'resume',
    subject: project,
    slug: 'handoff',
    title: 'Handoff',
    body: `---\nstatus: open\nepic: DEV-2226\nproject: ${project}\nwritten: 2020-01-01T00:00:00.000Z\n---\n\nNEXT ACTION: consume\n`,
  })
  if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = prior
  db()
    .query('UPDATE doc SET updated_at=? WHERE scope=? AND subject=?')
    .run('2020-01-01T00:00:00.000Z', 'context', `session:${session}`)

  await sweepSessionContext({
    enabled: true,
    dryRun: false,
    database: db(),
    presentation: presentation([], () => {}),
  })

  expect(getDoc('context', `session:${session}`, 'kept-for-resume')).not.toBeNull()
})

test('session context sweep resolves an open brief author past a later consume revision', async () => {
  const author = newRecordId()
  const consumer = newRecordId()
  const project = `sweep-revised-resume-${newRecordId()}`
  upsertProject({ recordId: newRecordId(), name: project, path: `/w/${project}`, settings: {} })
  const prior = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = author
  await setDoc({
    scope: 'context',
    subject: `session:${author}`,
    slug: 'kept-for-revised-resume',
    title: 'kept-for-revised-resume',
    body: encodeContextItem({ kind: 'fact', source: 'test', body: 'successor needs this' }),
  })
  const brief = await setDoc({
    scope: 'resume',
    subject: project,
    slug: 'handoff',
    title: 'Handoff',
    body: `---\nstatus: open\nepic: DEV-2226\nproject: ${project}\nwritten: 2020-01-01T00:00:00.000Z\n---\n\nNEXT ACTION: consume\n`,
  })
  process.env.CLAUDE_CODE_SESSION_ID = consumer
  await setDoc({
    scope: 'resume',
    subject: project,
    slug: 'handoff',
    title: 'Handoff',
    body: brief.body,
    expectedRevision: brief.revision ?? undefined,
  })
  db()
    .query(
      `UPDATE doc_revision SET op='consume'
       WHERE doc_record_id=? AND number=(SELECT MAX(number) FROM doc_revision WHERE doc_record_id=?)`,
    )
    .run(brief.record_id, brief.record_id)
  if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = prior
  db()
    .query('UPDATE doc SET updated_at=? WHERE scope=? AND subject=?')
    .run('2020-01-01T00:00:00.000Z', 'context', `session:${author}`)

  await sweepSessionContext({
    enabled: true,
    dryRun: false,
    database: db(),
    presentation: presentation([], () => {}),
  })

  expect(getDoc('context', `session:${author}`, 'kept-for-revised-resume')).not.toBeNull()
})

test('an owned terminal sweep candidate reaches close-out by UUID', async () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'orch-sweep-owned-terminal-'))
  Bun.spawnSync(['git', 'init', '--quiet'], { cwd: projectPath })
  const projectRecordId = newRecordId()
  const name = `sweep-owned-terminal-${projectRecordId}`
  upsertProject({
    recordId: projectRecordId,
    name,
    path: projectPath,
    settings: { trunk: 'main', worktree: { branch: 'orch-{id}' } },
  })
  const run = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const tree = join(projectPath, '.claude', 'worktrees', `orch-${run}`)
  db()
    .query('UPDATE run SET repo=?,project_record_id=?,worktree=?,cwd=? WHERE record_id=?')
    .run(name, projectRecordId, tree, tree, run)
  const actualSpawnSync = Bun.spawnSync.bind(Bun)
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], options) => {
    const command = args.join(' ')
    if (command === 'docker ps --format {{.Label "com.docker.compose.project.working_dir"}}')
      return result('')
    if (command.startsWith('docker ps -a --format')) return result('')
    if (command.startsWith('docker volume ls --format')) return result('')
    if (command === 'docker network ls --format {{.Name}}') return result('')
    return actualSpawnSync(args, options)
  }) as typeof Bun.spawnSync)

  try {
    const lines: string[] = []
    await sweepRuns(
      {
        dryRun: false,
        project: name,
        force: false,
        presentation: presentation(lines, () => {}),
      },
      {
        observeGrokTrustHeadings: () => ({ succeeded: true, headings: [] }),
        grokTrustPathFromHeading: () => null,
        hubTaskReader: async () => [],
        outboxMaintenance: {
          drain: () => {
            throw new Error('prune busy')
          },
          release: () => {
            throw new Error('release busy')
          },
          releasePages: () => {
            throw new Error('vacuum busy')
          },
        },
        telemetryMaintenance: {
          rollupContention: () => {
            throw new Error('rollup busy')
          },
          pruneContention: () => {
            throw new Error('contention prune busy')
          },
          pruneMonitor: () => {
            throw new Error('monitor prune busy')
          },
        },
      },
    )
    expect(db().query('SELECT close_out_outcome FROM run WHERE record_id=?').get(run)).toEqual({
      close_out_outcome: 'absent',
    })
    expect(lines).toContain('outbox prune failed: prune busy')
    expect(lines).toContain('outbox release failed: release busy')
    expect(lines).toContain('contention rollup failed: rollup busy')
    expect(lines).toContain('contention prune failed: contention prune busy')
    expect(lines).toContain('monitor prune failed: monitor prune busy')
    expect(lines).toContain('outbox space release failed: vacuum busy')
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

function presentation(lines: string[], setExitCode: (code: number) => void): CleanupPresentation {
  return {
    log: (...values) => lines.push(values.join(' ')),
    error: (...values) => lines.push(values.join(' ')),
    setExitCode,
    keptBranchLine: () => '',
  }
}

function result(stdout: string, exitCode = 0, stderr = ''): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    success: exitCode === 0,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}
