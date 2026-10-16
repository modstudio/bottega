import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from '../database/migrations.ts'
import { HOOK_TREE_JOB } from '../hook-tree/hook-tree.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from '../record/outbox-payload-contracts.ts'
import { sanitizeOutboxPayload } from '../record/outbox-sanitize.ts'
import { backfillRunRecords, buildRunRecordPayload, enqueueRunRecord } from './run-outbox.ts'

const RUN_RECORD_PAYLOAD_COLUMNS = OUTBOX_PAYLOAD_CONTRACTS.run.columns

test('terminal payload maps every hosted run column and no execution-state column', () => {
  const payload = sanitizeOutboxPayload(
    'run',
    buildRunRecordPayload(
      {
        id: 42,
        record_id: '01990000-0000-7000-8000-000000000042',
        project_name: 'project',
        project_record_id: '01990000-0000-7000-8000-000000001214',
        started_at: '2026-09-15T01:00:00.000Z',
        retry_record_id: null,
        parent_record_id: null,
        changed_paths: '["a.ts"]',
        doc_revisions: '["revision"]',
        outside_worktree_writes: null,
        review_provenance: '{"commands_run":[]}',
        started_by_user_id: '01990000-0000-7000-8000-000000000123',
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
    docRevisions: ['revision'],
    reviewProvenance: { commands_run: [] },
    startedByUserId: '01990000-0000-7000-8000-000000000123',
    projectId: '01990000-0000-7000-8000-000000001214',
  })
  expect(payload).not.toHaveProperty('cwd')
  expect(payload).not.toHaveProperty('outputPath')
  expect(payload).not.toHaveProperty('vendorSession')
})

test('backfill resolves chains, enqueues finished turns once, and skips running rows', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  database
    .query(
      `INSERT INTO project (record_id,name,path,canon,settings)
       VALUES ('01990000-0000-7000-8000-000000000201','project','/project',1,'{}')`,
    )
    .run()
  const insert = database.query(
    `INSERT INTO run (record_id,
       id, started_at, last_event_at, agent, job, project_record_id, prompt_sha, prompt_bytes,
       prompt_head, status, retry_of, parent_run_id
     ) VALUES (?, ?, ?, ?, 'codex', 'implement', ?, 'sha', 4, 'head', ?, ?, ?)`,
  )
  insert.run(
    newRecordId(),
    1,
    '2026-09-15T01:00:00.000Z',
    '2026-09-15T01:01:00.000Z',
    '01990000-0000-7000-8000-000000000201',
    'ok',
    null,
    null,
  )
  insert.run(
    newRecordId(),
    2,
    '2026-09-15T02:00:00.000Z',
    null,
    '01990000-0000-7000-8000-000000000201',
    'failed',
    1,
    null,
  )
  insert.run(
    newRecordId(),
    3,
    '2026-09-15T03:00:00.000Z',
    null,
    '01990000-0000-7000-8000-000000000201',
    'stale',
    null,
    1,
  )
  insert.run(
    newRecordId(),
    4,
    '2026-09-15T04:00:00.000Z',
    null,
    '01990000-0000-7000-8000-000000000201',
    'asking',
    null,
    null,
  )
  insert.run(
    newRecordId(),
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
    refreshedRoots: 0,
    skippedLive: 1,
  })
  const runs = database
    .query<{ id: number; record_id: string; status: string }, []>(
      'SELECT id, record_id, status FROM run ORDER BY id',
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
    projectName: null,
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
    refreshedRoots: 0,
    skippedLive: 1,
  })
  expect(
    database.query<{ count: number }, []>('SELECT count(*) AS count FROM outbox').get()!.count,
  ).toBe(4)
  database.close()
})

test('backfill leaves hook-tree rows local', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  database
    .query(
      `INSERT INTO run
       (record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,evidence_excluded)
       VALUES ('${newRecordId()}','2026-09-16T00:00:00.000Z','(hook)',?,'sha',4,'tree','ok','hook tree')`,
    )
    .run(HOOK_TREE_JOB)

  expect(backfillRunRecords(database, '01990000-0000-7000-8000-000000000099')).toEqual({
    enqueued: 0,
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
  const database = new Database(':memory:')
  applyMigrations(database)
  const insert = database.query(
    `INSERT INTO run
       (record_id,id,started_at,last_event_at,agent,job,prompt_sha,prompt_bytes,prompt_head,
        status,failure_kind,parent_run_id,turn)
     VALUES (?,?,'2026-10-16T12:00:00.000Z','2026-10-16T12:01:00.000Z',
             'codex','implement','sha',4,'head',?,?,NULL,1)`,
  )
  insert.run(newRecordId(), 1, 'ok', null)
  insert.run(newRecordId(), 2, 'failed', 'capacity')
  const machine = '01990000-0000-7000-8000-000000000099'
  // Give both roots an existing row: root 1 is stale and root 2 agrees.
  database.query("UPDATE run SET status='failed', failure_kind='capacity' WHERE id=1").run()
  enqueueRunRecord(database, 1, machine, '2026-10-16T12:01:00.000Z')
  enqueueRunRecord(database, 2, machine, '2026-10-16T12:01:00.000Z')
  database.query("UPDATE run SET status='ok', failure_kind=NULL WHERE id=1").run()

  expect(backfillRunRecords(database, machine)).toEqual({
    enqueued: 0,
    refreshedRoots: 1,
    skippedLive: 0,
  })
  const counts = database
    .query<{ id: number; count: number }, []>(
      `SELECT run.id, count(outbox.id) AS count FROM run
       JOIN outbox ON outbox.row_id=run.record_id
       GROUP BY run.id ORDER BY run.id`,
    )
    .all()
  expect(counts).toEqual([
    { id: 1, count: 2 },
    { id: 2, count: 1 },
  ])
  database.close()
})

test('backfill timestamps a refreshed root from its outcome-producing turn', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  const rootRecordId = newRecordId()
  database
    .query(
      `INSERT INTO run
       (record_id,id,started_at,last_event_at,latency_ms,agent,job,prompt_sha,prompt_bytes,
        prompt_head,status,failure_kind,parent_run_id,turn)
       VALUES (?,1,'2026-10-16T12:00:00.000Z','2026-10-16T12:01:00.000Z',60000,
               'codex','implement','sha',4,'root','ok',NULL,NULL,1)`,
    )
    .run(rootRecordId)
  database
    .query(
      `INSERT INTO run
       (record_id,id,started_at,last_event_at,latency_ms,agent,job,prompt_sha,prompt_bytes,
        prompt_head,status,failure_kind,parent_run_id,turn)
       VALUES (?,2,'2026-10-16T12:10:00.000Z','2026-10-16T12:15:00.000Z',300000,
               'codex','implement','sha',4,'turn','ok',NULL,1,2)`,
    )
    .run(newRecordId())
  const machine = '01990000-0000-7000-8000-000000000099'
  enqueueRunRecord(database, 2, machine, '2026-10-16T12:15:00.000Z')
  database.query("UPDATE run SET status='failed', failure_kind='capacity' WHERE id=1").run()
  enqueueRunRecord(database, 1, machine, '2026-10-16T12:01:00.000Z')
  database.query("UPDATE run SET status='ok', failure_kind=NULL WHERE id=1").run()

  expect(backfillRunRecords(database, machine)).toEqual({
    enqueued: 0,
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
