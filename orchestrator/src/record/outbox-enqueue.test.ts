import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  RECORD_SYNC_PENDING_MARKER,
  recordSyncQueueDirectory,
  STATE_HOME_ENV,
} from '../../../shared/state-directory.ts'
import { writeTransaction } from '../database/db.ts'
import { insertOutboxRow, refreshPendingOutboxRow } from './outbox-enqueue.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): Database {
  const database = new Database(':memory:')
  database.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY,
    record_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    row_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    actor_session TEXT
  )`)
  return database
}

function stateEnvironment(
  root: string,
  session = 'outbox-enqueue-session',
): Record<string, string> {
  return { [STATE_HOME_ENV]: root, CLAUDE_CODE_SESSION_ID: session }
}

test('inserts the row and creates the pending marker under the state root', () => {
  const root = mkdtempSync(join(tmpdir(), 'outbox-enqueue-'))
  roots.push(root)
  const database = fixture()
  const env = stateEnvironment(root)
  insertOutboxRow(
    database,
    {
      recordId: newRecordId(),
      kind: 'run',
      rowId: 'run-record',
      payload: '{}',
      createdAt: '2026-11-06T12:00:00.000Z',
    },
    env,
  )

  expect(
    database.query('SELECT kind,row_id,payload,created_at,actor_session FROM outbox').get(),
  ).toEqual({
    kind: 'run',
    row_id: 'run-record',
    payload: '{}',
    created_at: '2026-11-06T12:00:00.000Z',
    actor_session: 'outbox-enqueue-session',
  })
  expect(existsSync(join(recordSyncQueueDirectory(env), RECORD_SYNC_PENDING_MARKER))).toBe(true)
  database.close()
})

test('a marker write failure leaves the inserted row and does not throw', () => {
  const root = mkdtempSync(join(tmpdir(), 'outbox-enqueue-failure-'))
  roots.push(root)
  const env = stateEnvironment(root)
  const queue = recordSyncQueueDirectory(env)
  mkdirSync(join(root, 'orchestrator'), { recursive: true })
  writeFileSync(queue, 'blocks directory creation')
  const database = fixture()

  expect(() =>
    insertOutboxRow(
      database,
      {
        recordId: newRecordId(),
        kind: 'score',
        rowId: 'score-record',
        payload: '{}',
        createdAt: '2026-11-06T12:01:00.000Z',
      },
      env,
    ),
  ).not.toThrow()
  expect(
    database.query<{ count: number }, []>('SELECT count(*) AS count FROM outbox').get(),
  ).toEqual({
    count: 1,
  })
  database.close()
})

test('a transaction creates the marker only after its write commits', () => {
  const root = mkdtempSync(join(tmpdir(), 'outbox-enqueue-commit-'))
  roots.push(root)
  const database = fixture()
  const env = stateEnvironment(root)
  const marker = join(recordSyncQueueDirectory(env), RECORD_SYNC_PENDING_MARKER)

  writeTransaction(() => {
    insertOutboxRow(
      database,
      {
        recordId: newRecordId(),
        kind: 'run',
        rowId: 'committed-run',
        payload: '{}',
        createdAt: '2026-11-06T12:02:00.000Z',
      },
      env,
    )
    expect(existsSync(marker)).toBe(false)
  }, database)

  expect(existsSync(marker)).toBe(true)
  database.close()
})

test('a transaction creates the marker only after its pending-row refresh commits', () => {
  const root = mkdtempSync(join(tmpdir(), 'outbox-refresh-commit-'))
  roots.push(root)
  const database = fixture()
  const env = { [STATE_HOME_ENV]: root }
  const marker = join(recordSyncQueueDirectory(env), RECORD_SYNC_PENDING_MARKER)
  database
    .query(
      `INSERT INTO outbox (record_id,kind,row_id,payload,created_at,attempts,last_error)
       VALUES (?,?,?,?,?,3,'failed')`,
    )
    .run(newRecordId(), 'score', 'refreshed-score', '{}', '2026-11-06T12:03:00.000Z')

  writeTransaction(() => {
    refreshPendingOutboxRow(
      database,
      {
        id: 1,
        payload: '{"quality":4}',
        createdAt: '2026-11-06T12:04:00.000Z',
      },
      env,
    )
    expect(existsSync(marker)).toBe(false)
  }, database)

  expect(existsSync(marker)).toBe(true)
  expect(
    database.query('SELECT payload,created_at,attempts,last_error FROM outbox WHERE id=1').get(),
  ).toEqual({
    payload: '{"quality":4}',
    created_at: '2026-11-06T12:04:00.000Z',
    attempts: 0,
    last_error: null,
  })
  database.close()
})

test('a refreshed row is attributed to the session that last wrote it', () => {
  const root = mkdtempSync(join(tmpdir(), 'outbox-refresh-owner-'))
  roots.push(root)
  const database = fixture()
  const id = insertOutboxRow(
    database,
    {
      recordId: newRecordId(),
      kind: 'run',
      rowId: 'refreshed-owner',
      payload: '{}',
      createdAt: '2026-11-06T12:05:00.000Z',
    },
    stateEnvironment(root, 'first-session'),
  )

  refreshPendingOutboxRow(
    database,
    { id, payload: '{"updated":true}', createdAt: '2026-11-06T12:06:00.000Z' },
    stateEnvironment(root, 'second-session'),
  )

  expect(database.query('SELECT actor_session FROM outbox WHERE id=?').get(id)).toEqual({
    actor_session: 'second-session',
  })
  database.close()
})
