import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { fixtureProjectRecordId, migratedTestDatabase } from '../database/test-database.fixture.ts'
import { HOOK_TREE_JOB } from '../hook-tree/hook-tree.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from '../record/outbox-payload-contracts.ts'
import { sanitizeOutboxPayload } from '../record/outbox-sanitize.ts'
import {
  backfillRunRecords,
  buildRunRecordPayload,
  enqueueRunRecord,
  shouldRefreshRunRecordLinks,
} from './run-outbox.ts'

const RUN_RECORD_PAYLOAD_COLUMNS = OUTBOX_PAYLOAD_CONTRACTS.run.columns

test('link refresh requires a new local link absent from the latest payload', () => {
  const projectId = '01990000-0000-7000-8000-000000001214'
  const taskId = '01990000-0000-7000-8000-000000001771'
  expect(shouldRefreshRunRecordLinks({}, projectId, null)).toBe(true)
  expect(shouldRefreshRunRecordLinks({}, null, taskId)).toBe(true)
  expect(shouldRefreshRunRecordLinks({ projectId }, projectId, null)).toBe(false)
  expect(shouldRefreshRunRecordLinks({ taskId }, null, taskId)).toBe(false)
  expect(shouldRefreshRunRecordLinks({}, null, null)).toBe(false)
  expect(shouldRefreshRunRecordLinks({ projectName: 'project' }, projectId, null)).toBe(true)
})

test('terminal payload maps every hosted run column and no execution-state column', () => {
  const payload = sanitizeOutboxPayload(
    'run',
    buildRunRecordPayload(
      {
        number: 42,
        record_id: '01990000-0000-7000-8000-000000000042',
        project_name: 'project',
        project_record_id: '01990000-0000-7000-8000-000000001214',
        task_record_id: '01990000-0000-7000-8000-000000001771',
        started_at: '2026-09-15T01:00:00.000Z',
        retry_record_id: null,
        parent_record_id: null,
        changed_paths: '["a.ts"]',
        doc_revisions: '["01990000-0000-7000-8000-000000000043"]',
        outside_worktree_writes: null,
        review_provenance: '{"commands_run":[]}',
        started_by_user_id: '01990000-0000-7000-8000-000000000123',
        resource_cpu_ms: 12_345,
        resource_peak_rss_bytes: 67_890,
        resource_samples: 4,
        resource_source: 'sampled',
      },
      '01990000-0000-7000-8000-000000000099',
      '2026-09-15T01:01:00.000Z',
    ),
  )
  expect(Object.keys(payload).sort()).toEqual([...RUN_RECORD_PAYLOAD_COLUMNS].sort())
  expect(payload).toMatchObject({
    localId: 42,
    createdAt: '2026-09-15T01:00:00.000Z',
    finishedAt: '2026-09-15T01:01:00.000Z',
    updatedAt: '2026-09-15T01:01:00.000Z',
    changedPaths: ['a.ts'],
    docRevisions: ['01990000-0000-7000-8000-000000000043'],
    reviewProvenance: { commands_run: [] },
    startedByUserId: '01990000-0000-7000-8000-000000000123',
    projectId: '01990000-0000-7000-8000-000000001214',
    taskId: '01990000-0000-7000-8000-000000001771',
    resourceCpuMs: 12_345,
    resourcePeakRssBytes: 67_890,
    resourceSamples: 4,
    resourceSource: 'sampled',
  })
  expect(payload).not.toHaveProperty('cwd')
  expect(payload).not.toHaveProperty('outputPath')
  expect(payload).not.toHaveProperty('vendorSession')
})

test('backfill resolves chains, enqueues finished turns once, and skips running rows', () => {
  const database = migratedTestDatabase()
  database
    .query(
      `INSERT INTO project (record_id,name,path,canon,settings)
       VALUES ('01990000-0000-7000-8000-000000000201','project','/project',1,'{}')`,
    )
    .run()
  const insert = database.query(
    `INSERT INTO run (record_id,
       number, started_at, last_event_at, agent, job, project_record_id, prompt_sha, prompt_bytes,
       prompt_head, status, retry_of_record_id, parent_run_record_id
     ) VALUES (?, ?, ?, ?, 'codex', 'implement', ?, 'sha', 4, 'head', ?, ?, ?)`,
  )
  const runIds = Array.from({ length: 5 }, () => newRecordId())
  insert.run(
    runIds[0]!,
    1,
    '2026-09-15T01:00:00.000Z',
    '2026-09-15T01:01:00.000Z',
    '01990000-0000-7000-8000-000000000201',
    'ok',
    null,
    null,
  )
  insert.run(
    runIds[1]!,
    2,
    '2026-09-15T02:00:00.000Z',
    null,
    '01990000-0000-7000-8000-000000000201',
    'failed',
    runIds[0]!,
    null,
  )
  insert.run(
    runIds[2]!,
    3,
    '2026-09-15T03:00:00.000Z',
    null,
    '01990000-0000-7000-8000-000000000201',
    'stale',
    null,
    runIds[0]!,
  )
  insert.run(
    runIds[3]!,
    4,
    '2026-09-15T04:00:00.000Z',
    null,
    '01990000-0000-7000-8000-000000000201',
    'asking',
    null,
    null,
  )
  insert.run(
    runIds[4]!,
    5,
    '2026-09-15T05:00:00.000Z',
    null,
    '01990000-0000-7000-8000-000000000201',
    'running',
    null,
    null,
  )

  expect(backfillRunRecords(database, '01990000-0000-7000-8000-000000000099')).toEqual({
    enqueued: 4,
    refreshedLinks: 0,
    refreshedRoots: 0,
    skippedLive: 1,
  })
  const runs = database
    .query<{ id: string; record_id: string; status: string }, []>(
      'SELECT record_id AS id, record_id, status FROM run ORDER BY number',
    )
    .all()
  expect(runs.every((row) => typeof row.record_id === 'string')).toBe(true)
  expect(runs.slice(3).map((row) => row.status)).toEqual(['asking', 'running'])

  const payloads = database
    .query<{ payload: string }, []>("SELECT payload FROM outbox WHERE kind='run' ORDER BY id")
    .all()
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>)
  expect(payloads).toHaveLength(4)
  expect(payloads[0]).toMatchObject({
    projectName: 'project',
    projectId: '01990000-0000-7000-8000-000000000201',
    finishedAt: '2026-09-15T01:01:00.000Z',
  })
  expect(payloads[1]).toMatchObject({
    retryOf: runs[0]!.record_id,
    finishedAt: '2026-09-15T02:00:00.000Z',
  })
  expect(payloads[2]).toMatchObject({ parentRunId: runs[0]!.record_id })
  expect(payloads[3]).toMatchObject({ status: 'asking' })
  expect(backfillRunRecords(database, '01990000-0000-7000-8000-000000000099')).toEqual({
    enqueued: 0,
    refreshedLinks: 0,
    refreshedRoots: 0,
    skippedLive: 1,
  })
  expect(
    database.query<{ count: number }, []>('SELECT count(*) AS count FROM outbox').get()!.count,
  ).toBe(4)
  database.close()
})

test('backfill leaves hook-tree rows local', () => {
  const database = migratedTestDatabase()
  fixtureProjectRecordId(database)
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,evidence_excluded,project_record_id)
       VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-09-16T00:00:00.000Z','(hook)',?,'sha',4,'tree','ok','hook tree',
               (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
    )
    .run(HOOK_TREE_JOB)

  expect(backfillRunRecords(database, '01990000-0000-7000-8000-000000000099')).toEqual({
    enqueued: 0,
    refreshedLinks: 0,
    refreshedRoots: 0,
    skippedLive: 0,
  })
  expect(database.query('SELECT record_id FROM run').get()).toEqual({
    record_id: expect.any(String),
  })
  expect(
    database.query<{ count: number }, []>('SELECT count(*) count FROM outbox').get()!.count,
  ).toBe(0)
  database.close()
})

test('backfill refreshes only roots whose latest run payload disagrees', () => {
  const database = migratedTestDatabase()
  fixtureProjectRecordId(database)
  const insert = database.query(
    `INSERT INTO run
       (record_id,number,started_at,last_event_at,agent,job,prompt_sha,prompt_bytes,prompt_head,
        status,failure_kind,parent_run_record_id,turn,project_record_id)
     VALUES (?,?,'2026-10-16T12:00:00.000Z','2026-10-16T12:01:00.000Z',
             'codex','implement','sha',4,'head',?,?,NULL,1,
             (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
  )
  const firstRecordId = newRecordId()
  const secondRecordId = newRecordId()
  insert.run(firstRecordId, 1, 'ok', null)
  insert.run(secondRecordId, 2, 'failed', 'capacity')
  const machine = '01990000-0000-7000-8000-000000000099'
  // Give both roots an existing row: root 1 is stale and root 2 agrees.
  database
    .query("UPDATE run SET status='failed', failure_kind='capacity' WHERE record_id=?")
    .run(firstRecordId)
  enqueueRunRecord(database, firstRecordId, machine, '2026-10-16T12:01:00.000Z')
  enqueueRunRecord(database, secondRecordId, machine, '2026-10-16T12:01:00.000Z')
  database
    .query("UPDATE run SET status='ok', failure_kind=NULL WHERE record_id=?")
    .run(firstRecordId)

  expect(backfillRunRecords(database, machine)).toEqual({
    enqueued: 0,
    refreshedLinks: 0,
    refreshedRoots: 1,
    skippedLive: 0,
  })
  const counts = database
    .query<{ id: string; count: number }, []>(
      `SELECT run.record_id AS id, count(outbox.id) AS count FROM run
       JOIN outbox ON outbox.row_id=run.record_id
       GROUP BY run.record_id ORDER BY run.number`,
    )
    .all()
  expect(counts).toEqual([
    { id: firstRecordId, count: 2 },
    { id: secondRecordId, count: 1 },
  ])
  database.close()
})

test('backfill refreshes stale links for roots and turns only once', () => {
  const database = migratedTestDatabase()
  fixtureProjectRecordId(database)
  const projectId = database
    .query<{ record_id: string }, []>('SELECT record_id FROM project ORDER BY name LIMIT 1')
    .get()!.record_id
  const rootId = newRecordId()
  const turnId = newRecordId()
  const insert = database.query(
    `INSERT INTO run
       (record_id,number,started_at,last_event_at,agent,job,prompt_sha,prompt_bytes,prompt_head,
        status,parent_run_record_id,turn,project_record_id)
     VALUES (?,?,'2026-10-26T12:00:00.000Z','2026-10-26T12:01:00.000Z',
             'codex','implement','sha',4,'head','ok',?,?,?)`,
  )
  insert.run(rootId, 1, null, 1, projectId)
  insert.run(turnId, 2, rootId, 2, projectId)
  const oldPayload = JSON.stringify({ projectName: 'project', status: 'ok', failureKind: null })
  const addOutbox = database.query(
    `INSERT INTO outbox (record_id,kind,row_id,payload,created_at)
     VALUES (?,'run',?,?, '2026-10-26T12:01:00.000Z')`,
  )
  addOutbox.run(newRecordId(), rootId, oldPayload)
  addOutbox.run(newRecordId(), turnId, oldPayload)
  const machine = '01990000-0000-7000-8000-000000000099'

  expect(backfillRunRecords(database, machine)).toEqual({
    enqueued: 0,
    refreshedLinks: 2,
    refreshedRoots: 0,
    skippedLive: 0,
  })
  expect(backfillRunRecords(database, machine)).toEqual({
    enqueued: 0,
    refreshedLinks: 0,
    refreshedRoots: 0,
    skippedLive: 0,
  })
  expect(
    database
      .query<{ count: number }, []>("SELECT count(*) AS count FROM outbox WHERE kind='run'")
      .get()!.count,
  ).toBe(4)
  database.close()
})

test('backfill timestamps a refreshed root from its outcome-producing turn', () => {
  const database = migratedTestDatabase()
  fixtureProjectRecordId(database)
  const rootRecordId = newRecordId()
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,last_event_at,latency_ms,agent,job,prompt_sha,prompt_bytes,
        prompt_head,status,failure_kind,parent_run_record_id,turn,project_record_id)
       VALUES (?,1,'2026-10-16T12:00:00.000Z','2026-10-16T12:01:00.000Z',60000,
               'codex','implement','sha',4,'root','ok',NULL,NULL,1,
               (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
    )
    .run(rootRecordId)
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,last_event_at,latency_ms,agent,job,prompt_sha,prompt_bytes,
        prompt_head,status,failure_kind,parent_run_record_id,turn,project_record_id)
       VALUES (?,2,'2026-10-16T12:10:00.000Z','2026-10-16T12:15:00.000Z',300000,
               'codex','implement','sha',4,'turn','ok',NULL,?,2,
               (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
    )
    .run(newRecordId(), rootRecordId)
  const machine = '01990000-0000-7000-8000-000000000099'
  const childRecordId = (
    database.query('SELECT record_id FROM run WHERE parent_run_record_id=?').get(rootRecordId) as {
      record_id: string
    }
  ).record_id
  enqueueRunRecord(database, childRecordId, machine, '2026-10-16T12:15:00.000Z')
  database
    .query("UPDATE run SET status='failed', failure_kind='capacity' WHERE record_id=?")
    .run(rootRecordId)
  enqueueRunRecord(database, rootRecordId, machine, '2026-10-16T12:01:00.000Z')
  database
    .query("UPDATE run SET status='ok', failure_kind=NULL WHERE record_id=?")
    .run(rootRecordId)

  expect(backfillRunRecords(database, machine)).toEqual({
    enqueued: 0,
    refreshedLinks: 0,
    refreshedRoots: 1,
    skippedLive: 0,
  })
  const payload = database
    .query<{ payload: string }, [string]>(
      `SELECT payload FROM outbox WHERE kind='run' AND row_id=? ORDER BY id DESC LIMIT 1`,
    )
    .get(rootRecordId)!
  expect(JSON.parse(payload.payload)).toMatchObject({
    status: 'ok',
    failureKind: null,
    finishedAt: '2026-10-16T12:15:00.000Z',
    updatedAt: '2026-10-16T12:15:00.000Z',
  })
  database.close()
})
