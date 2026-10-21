import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyRecordSyncBatchResults } from './record-sync-results.ts'

const STAMP = '2026-10-21T00:00:00.000Z'

test('a held row stays pending until a following synced result delivers it', () => {
  using local = new Database(':memory:')
  local.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, record_id TEXT NOT NULL, row_id TEXT NOT NULL,
    payload TEXT NOT NULL, created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, synced_at TEXT, quarantined_at TEXT, quarantine_reason TEXT,
    retired_at TEXT, retirement_reason TEXT
  ); CREATE TABLE record_install_binding (id INTEGER PRIMARY KEY, bound_at TEXT NOT NULL)`)
  local
    .query(
      "INSERT INTO outbox (id,kind,record_id,row_id,payload,created_at) VALUES (1,'run','record','row','{}',?)",
    )
    .run(STAMP)
  const common = {
    local,
    batch: [{ id: 1, kind: 'run', payload: '{}', spaceHint: null }],
    localRows: new Map([[1, { id: 1, kind: 'run', row_id: 'row', payload: '{}' }]]),
    dependencies: [{ id: 1, sameBatchParentIdGroups: [] }],
    readOnlyDeferred: new Map<string, number>(),
    now: () => STAMP,
  }
  const held = new Map()
  expect(
    applyRecordSyncBatchResults({
      ...common,
      attempted: new Set(),
      held,
      response: { results: [{ id: 1, status: 'held', reason: 'upgrade required' }] },
    }),
  ).toEqual({ pushed: 0, failed: 0 })
  expect(
    local.query('SELECT attempts,last_error,synced_at,quarantined_at FROM outbox WHERE id=1').get(),
  ).toEqual({
    attempts: 1,
    last_error: 'upgrade required',
    synced_at: null,
    quarantined_at: null,
  })
  expect([...held.values()]).toEqual([{ kind: 'run', rows: 1, reason: 'upgrade required' }])

  expect(
    applyRecordSyncBatchResults({
      ...common,
      attempted: new Set(),
      held: new Map(),
      response: { results: [{ id: 1, status: 'synced' }] },
    }),
  ).toEqual({ pushed: 1, failed: 0 })
  expect(local.query('SELECT synced_at,quarantined_at FROM outbox WHERE id=1').get()).toEqual({
    synced_at: STAMP,
    quarantined_at: null,
  })
})
