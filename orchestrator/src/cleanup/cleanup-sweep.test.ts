import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { encodeContextItem } from '../../test/fixtures/context-item.ts'
import { setDoc } from '../../test/fixtures/docs.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from '../board/board-mode.ts'
import { postNotice } from '../board/board-service.ts'
import { register as registerCleanupCommands } from '../commands/cleanup.ts'
import { db } from '../database/db.ts'
import { getContextItem } from '../doc/context-item-store.ts'
import { sessionResumeBriefState } from '../doc/context-service.ts'
import { CONTEXT_FACTS_PORTS_KEY, type ContextFactsPorts } from '../doc/context-write-adapter.ts'
import { upsertProject } from '../project/projects.ts'
import type { SessionCloseOutReport } from '../session/session-close-out.ts'
import { markSessionCloseOutSwept } from '../session/session-close-out-store.ts'
import type { CleanupPresentation } from './cleanup.ts'
import { sweepRuns } from './cleanup-sweep.ts'
import {
  decideSessionContextSweep,
  sessionContextOwnershipLine,
  sweepSessionContext,
} from './cleanup-sweep-context.ts'
import { reportDockerInventoryFinish } from './cleanup-sweep-docker.ts'
import { sweepSessionCloseOutRecords } from './cleanup-sweep-session-close-out.ts'

afterEach(() => {
  mock.restore()
  installRecordApiClient(null)
})

test('sweep finish reports Docker absence once and each failure reason once', () => {
  const info: string[] = []
  const errors: string[] = []
  let dockerAbsent = false
  const observeDockerAbsent = () => {
    dockerAbsent = true
  }
  observeDockerAbsent()
  observeDockerAbsent()

  reportDockerInventoryFinish(
    {
      log: (...values) => info.push(values.join(' ')),
      error: (...values) => errors.push(values.join(' ')),
      setExitCode: () => {},
      keptBranchLine: () => '',
    },
    {
      errors: new Set(['docker ps -a inventory unavailable: daemon unavailable']),
      absent: dockerAbsent,
    },
  )

  expect(info).toEqual(['docker: executable not found; Docker inventory steps skipped'])
  expect(errors).toEqual(['docker ps -a inventory unavailable: daemon unavailable'])
})

test('hosted session context sweep keeps foreign holders and drops owned expired holders', () => {
  expect(
    decideSessionContextSweep({
      readSource: 'hosted',
      localOwnerEvidence: false,
      ownerGone: true,
      hasUnconsumedResumeBrief: false,
    }),
  ).toBe('not-owned-by-this-install')
  expect(
    decideSessionContextSweep({
      readSource: 'hosted',
      localOwnerEvidence: true,
      ownerGone: true,
      hasUnconsumedResumeBrief: false,
    }),
  ).toBe('drop')
  expect(sessionContextOwnershipLine(1)).toBe(
    'session context: kept 1 holder not owned by this install',
  )
})

test('hosted session context sweep keeps owned holders for open or unreadable resume briefs', async () => {
  const session = newRecordId()
  const project = `hosted-resume-${newRecordId()}`
  const projectRecordId = newRecordId()
  upsertProject({
    recordId: projectRecordId,
    name: project,
    path: `/w/${project}`,
    settings: { space: 'project-space' },
  })
  addRun({ agent: 'codex', job: 'implement', session, projectRecordId })
  const memory = createMemoryRecordApiClient()
  installRecordApiClient({
    ...memory,
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'other-space',
      personalSpaceId: 'personal-space',
      memberships: [
        { space_id: 'other-space', slug: 'other', permission: 'write' },
        { space_id: 'project-space', slug: 'project-space', permission: 'write' },
      ],
    }),
    listDocs: async () => ({
      items: [
        {
          id: newRecordId(),
          body: `---\nstatus: open\nproject: ${project}\n---\n\nNEXT ACTION: continue`,
        },
      ],
      nextCursor: null,
    }),
    listRevisions: async () => [
      { op: 'upsert', sessionId: session, at: '2026-11-20T00:00:00.000Z' },
    ],
  })

  const open = await sessionResumeBriefState('hosted', db(), session)
  expect(open).toBe('open')
  expect(
    decideSessionContextSweep({
      readSource: 'hosted',
      localOwnerEvidence: true,
      ownerGone: true,
      hasUnconsumedResumeBrief: open !== 'absent',
    }),
  ).toBe('keep')

  installRecordApiClient({
    ...memory,
    whoami: async () => ({
      user: { id: 'user-a' },
      activeSpaceId: 'other-space',
      personalSpaceId: 'personal-space',
      memberships: [{ space_id: 'project-space', slug: 'project-space', permission: 'write' }],
    }),
    listDocs: async () => {
      throw new Error('record unavailable')
    },
  })
  const unreadable = await sessionResumeBriefState('hosted', db(), session)
  expect(unreadable).toBe('unreadable')
  expect(
    decideSessionContextSweep({
      readSource: 'hosted',
      localOwnerEvidence: true,
      ownerGone: true,
      hasUnconsumedResumeBrief: unreadable !== 'absent',
    }),
  ).toBe('keep')
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
    reported: [],
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
  ] = {
    task: async () => null,
    lookup: async () => null,
    record: async () => null,
    children: async () => [],
    pointer: async () => null,
  }
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
    .query(
      "UPDATE context_item SET created_at=?,updated_at=? WHERE holder_kind='session' AND holder_id=?",
    )
    .run('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', session)
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
  expect(await getContextItem(`session:${session}`, 'one')).toBeNull()
  expect(await getContextItem(`session:${session}`, 'two')).toBeNull()
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
        .query("UPDATE context_item SET updated_at=? WHERE holder_kind='session' AND holder_id=?")
        .run('2020-01-01T00:00:00.000Z', session)
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

    expect(await getContextItem(`session:${session}`, 'live')).not.toBeNull()
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
    .query("UPDATE context_item SET updated_at=? WHERE holder_kind='session' AND holder_id=?")
    .run('2020-01-01T00:00:00.000Z', session)

  await sweepSessionContext({
    enabled: true,
    dryRun: false,
    database: db(),
    presentation: presentation([], () => {}),
  })

  expect(await getContextItem(`session:${session}`, 'kept-for-resume')).not.toBeNull()
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
    .query("UPDATE context_item SET updated_at=? WHERE holder_kind='session' AND holder_id=?")
    .run('2020-01-01T00:00:00.000Z', author)

  await sweepSessionContext({
    enabled: true,
    dryRun: false,
    database: db(),
    presentation: presentation([], () => {}),
  })

  expect(await getContextItem(`session:${author}`, 'kept-for-revised-resume')).not.toBeNull()
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
  const retainedBoardMessage = postNotice(
    { audience: 'operator', title: 'Hosted install local history', body: 'Keep this local row.' },
    {},
    Date.parse('2020-01-01T00:00:00.000Z'),
  )
  const retainedClaim = newRecordId()
  db()
    .query(
      `INSERT INTO board_claim
       (record_id,project,subject_kind,subject_value,holder_kind,holder_session,duration_ms,taken_at,renewed_at,lapses_at)
       VALUES (?,?,'task','DEV-HOSTED','architect','hosted-holder',60000,?,?,?)`,
    )
    .run(
      retainedClaim,
      name,
      '2020-01-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
      '2020-01-01T00:01:00.000Z',
    )
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

  const endpoint = process.env.BOTTEGA_RECORD_API_URL
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
        observeGrokTrustHeadings: () => {
          db().query('DELETE FROM schema_meta WHERE key=?').run(BOARD_HOSTED_ADOPTED_KEY)
          if (endpoint === undefined) delete process.env.BOTTEGA_RECORD_API_URL
          else process.env.BOTTEGA_RECORD_API_URL = endpoint
          return { succeeded: true, headings: [] }
        },
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
            db()
              .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
              .run(BOARD_HOSTED_ADOPTED_KEY, '1')
            process.env.BOTTEGA_RECORD_API_URL = 'https://record.test'
            return 'not-incremental'
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
    expect(
      db()
        .query('SELECT record_id FROM board_message WHERE record_id=?')
        .get(retainedBoardMessage.recordId),
    ).toEqual({ record_id: retainedBoardMessage.recordId })
    expect(
      db().query('SELECT closed_at FROM board_claim WHERE record_id=?').get(retainedClaim),
    ).toEqual({ closed_at: null })
    expect(lines).toContain('outbox release failed: release busy')
    expect(lines).toContain('contention rollup failed: rollup busy')
    expect(lines).toContain('contention prune failed: contention prune busy')
    expect(lines).toContain('monitor prune failed: monitor prune busy')
    expect(lines).toContain(
      `outbox space not returned: store is not yet incremental; run ${PLATFORM_SLUG} machine update`,
    )
  } finally {
    db().query('DELETE FROM schema_meta WHERE key=?').run(BOARD_HOSTED_ADOPTED_KEY)
    if (endpoint === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = endpoint
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

const runNumber = (recordId: string): number =>
  (db().query('SELECT number FROM run WHERE record_id=?').get(recordId) as { number: number })
    .number

async function runAskingRepairSweep(projectName: string): Promise<string[]> {
  const lines: string[] = []
  spyOn(console, 'log').mockImplementation((...values) => lines.push(values.join(' ')))
  const actualSpawnSync = Bun.spawnSync.bind(Bun)
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[], options) => {
    const command = args.join(' ')
    if (command.startsWith('docker ')) return result('')
    return actualSpawnSync(args, options)
  }) as typeof Bun.spawnSync)
  const program = new Command().exitOverride()
  registerCleanupCommands(program)
  await program.parseAsync(['sweep', '--project', projectName], { from: 'user' })
  process.exitCode = 0
  return lines
}

test('sweep repairs a superseded asking turn with its audit reason and outbox row', async () => {
  const projectName = `asking-sweep-${newRecordId()}`
  const projectPath = mkdtempSync(join(tmpdir(), `${projectName}-`))
  const projectRecordId = newRecordId()
  upsertProject({
    recordId: projectRecordId,
    name: projectName,
    path: projectPath,
    settings: { trunk: 'main', worktree: { branch: 'orch-{id}' } },
  })
  const root = addRun({ agent: 'codex', job: 'craft', status: 'ok', projectRecordId })
  const asking = addRun({
    agent: 'codex',
    job: 'craft',
    status: 'asking',
    parent: root,
    turn: 2,
    projectRecordId,
  })
  const latest = addRun({
    agent: 'codex',
    job: 'craft',
    status: 'ok',
    parent: root,
    turn: 3,
    projectRecordId,
  })

  try {
    await runAskingRepairSweep(projectName)
    expect(db().query('SELECT status FROM run WHERE record_id=?').get(asking)).toEqual({
      status: 'ok',
    })
    expect(
      db().query('SELECT action,reason FROM run_mutation_audit WHERE run_record_id=?').get(asking),
    ).toEqual({ action: 'reap', reason: `superseded by run ${runNumber(latest)}` })
    expect(
      db().query("SELECT row_id FROM outbox WHERE kind='run' AND row_id=?").get(asking),
    ).toEqual({ row_id: asking })
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

test('sweep restores an overwritten architect abandon verdict and rolls up its root', async () => {
  const projectName = `abandon-sweep-${newRecordId()}`
  const projectPath = mkdtempSync(join(tmpdir(), `${projectName}-`))
  const projectRecordId = newRecordId()
  upsertProject({
    recordId: projectRecordId,
    name: projectName,
    path: projectPath,
    settings: { trunk: 'main', worktree: { branch: 'orch-{id}' } },
  })
  const root = addRun({ agent: 'codex', job: 'craft', status: 'ok', projectRecordId })
  const asking = addRun({
    agent: 'codex',
    job: 'craft',
    status: 'asking',
    parent: root,
    turn: 2,
    projectRecordId,
  })
  db()
    .query(
      `INSERT INTO run_mutation_audit
         (record_id,run_record_id,root_run_record_id,action,at,reason)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(newRecordId(), root, root, 'abandon', new Date().toISOString(), 'late worker')

  try {
    await runAskingRepairSweep(projectName)
    expect(db().query('SELECT status,failure_kind FROM run WHERE record_id=?').get(asking)).toEqual(
      {
        status: 'stale',
        failure_kind: 'abandoned',
      },
    )
    expect(db().query('SELECT status FROM run WHERE record_id=?').get(root)).toEqual({
      status: 'stale',
    })
    expect(
      db()
        .query(
          'SELECT action,reason FROM run_mutation_audit WHERE run_record_id=? ORDER BY rowid DESC',
        )
        .get(asking),
    ).toEqual({
      action: 'reap',
      reason: 'architect abandon verdict restored after late terminal write',
    })
    expect(
      db().query("SELECT row_id FROM outbox WHERE kind='run' AND row_id=?").get(asking),
    ).toEqual({ row_id: asking })
  } finally {
    rmSync(projectPath, { recursive: true, force: true })
  }
})

function result(stdout: string, exitCode = 0, stderr = ''): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    success: exitCode === 0,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}
