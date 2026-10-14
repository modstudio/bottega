import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import { HOOK_TREE_JOB } from '../hook-tree/hook-tree.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from '../record/outbox-payload-contracts.ts'
import { sanitizeOutboxPayload } from '../record/outbox-sanitize.ts'
import { backfillRunRecords, buildRunRecordPayload } from './run-outbox.ts'

const RUN_RECORD_PAYLOAD_COLUMNS = OUTBOX_PAYLOAD_CONTRACTS.run.columns

test('terminal payload maps every hosted run column and no execution-state column', () => {
  const payload = sanitizeOutboxPayload(
    'run',
    buildRunRecordPayload(
      {
        id: 42,
        record_id: '01990000-0000-7000-8000-000000000042',
        project_name: 'project',
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
      `INSERT INTO project (id, name, path, canon, settings)
       VALUES (1, 'project', '/project', 1, '{}')`,
    )
    .run()
  const insert = database.query(
    `INSERT INTO run (record_id,
       id, started_at, last_event_at, agent, job, project_id, prompt_sha, prompt_bytes,
       prompt_head, status, retry_of, parent_run_id
     ) VALUES ('00000000-0000-4000-8000-' || lower(hex(randomblob(6))),?, ?, ?, 'codex', 'implement', ?, 'sha', 4, 'head', ?, ?, ?)`,
  )
  insert.run(1, '2026-09-15T01:00:00.000Z', '2026-09-15T01:01:00.000Z', null, 'ok', null, null)
  insert.run(2, '2026-09-15T02:00:00.000Z', null, 1, 'failed', 1, null)
  insert.run(3, '2026-09-15T03:00:00.000Z', null, 1, 'stale', null, 1)
  insert.run(4, '2026-09-15T04:00:00.000Z', null, 1, 'asking', null, null)
  insert.run(5, '2026-09-15T05:00:00.000Z', null, 1, 'running', null, null)

  expect(backfillRunRecords(database, '01990000-0000-7000-8000-000000000099')).toEqual({
    minted: 0,
    enqueued: 4,
    skippedLive: 1,
  })
  const runs = database
    .query<{ id: number; record_id: string; status: string }, []>(
      'SELECT id, record_id, status FROM run ORDER BY id',
    )
    .all()
  expect(new Set(runs.map((row) => row.record_id))).toHaveLength(5)
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
    minted: 0,
    enqueued: 0,
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
      `INSERT INTO run (record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,evidence_excluded) VALUES ('00000000-0000-4000-8000-' || lower(hex(randomblob(6))),'2026-09-16T00:00:00.000Z','(hook)',?,'sha',4,'tree','ok','hook tree')`,
    )
    .run(HOOK_TREE_JOB)

  expect(backfillRunRecords(database, '01990000-0000-7000-8000-000000000099')).toEqual({
    minted: 0,
    enqueued: 0,
    skippedLive: 0,
  })
  expect(
    database.query<{ record_id: string }, []>('SELECT record_id FROM run').get()!.record_id,
  ).toMatch(/^[0-9a-f-]{36}$/)
  expect(
    database.query<{ count: number }, []>('SELECT count(*) count FROM outbox').get()!.count,
  ).toBe(0)
  database.close()
})
