import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { measureOutboxPayload, readOutboxRow, reportOutboxRow, utf8Bytes } from './outbox-read.ts'
import { outboxPayloadForRecordSync } from './record-sync.ts'
import { planRecordSyncBatch } from './record-sync-batch.ts'
import { RECORD_SYNC_MAX_PAYLOAD_BYTES } from './record-sync-contract.ts'

const STAMP = '2026-11-26T12:00:00.000Z'

function outbox(payload: string): Database {
  const database = new Database(':memory:')
  database.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, record_id TEXT NOT NULL, row_id TEXT NOT NULL,
    payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, synced_at TEXT,
    quarantined_at TEXT, quarantine_reason TEXT, retired_at TEXT
  );
  CREATE TABLE project (record_id TEXT PRIMARY KEY);
  CREATE TABLE review_funnel_decision (record_id TEXT PRIMARY KEY, project_record_id TEXT)`)
  database
    .query(
      `INSERT INTO outbox
       (id,kind,record_id,row_id,payload,attempts,quarantined_at,quarantine_reason)
       VALUES (7,'review_funnel_decision','outbox-record','decision-record',?,3,?,'too large')`,
    )
    .run(payload, STAMP)
  return database
}

function readReport(rowId: number, database: Database) {
  const row = readOutboxRow(database, rowId)
  if (!row) throw new Error('missing fixture row')
  return reportOutboxRow(row, outboxPayloadForRecordSync(database, row))
}

test('payload measurement reports exact nested JSON sizes only past the threshold', () => {
  const payload = {
    large: { nested: 'x'.repeat(80), count: 12 },
    small: { ok: true },
    scalar: 'known-sentinel-value',
  }
  const serialized = JSON.stringify(payload)
  const fields = measureOutboxPayload(payload, utf8Bytes(serialized))

  expect(fields.map((field) => field.name)).toEqual(['large', 'scalar', 'small'])
  expect(fields[0]).toEqual({
    name: 'large',
    type: 'object',
    bytes: utf8Bytes(JSON.stringify(payload.large)),
    children: [
      {
        name: 'nested',
        type: 'string',
        bytes: utf8Bytes(JSON.stringify(payload.large.nested)),
      },
      { name: 'count', type: 'number', bytes: utf8Bytes(JSON.stringify(payload.large.count)) },
    ],
  })
  expect(fields.find((field) => field.name === 'small')?.children).toBeUndefined()
  expect(JSON.stringify(fields)).not.toContain('known-sentinel-value')
})

test('array summaries report count and the largest element without values', () => {
  const payload = { rows: ['x', 'longer value', { nested: true }] }
  const fields = measureOutboxPayload(payload, utf8Bytes(JSON.stringify(payload)))

  expect(fields).toEqual([
    {
      name: 'rows',
      type: 'array',
      bytes: utf8Bytes(JSON.stringify(payload.rows)),
      children: {
        count: 3,
        bytes: utf8Bytes(JSON.stringify(payload.rows)),
        largestIndex: 2,
        largestBytes: utf8Bytes(JSON.stringify(payload.rows[2])),
      },
    },
  ])
  expect(JSON.stringify(fields)).not.toContain('longer value')
})

test('row report derives state and uses the sync byte measurement without printing values', () => {
  const payload = JSON.stringify({ secret: 'known-sentinel-value', nested: { count: 2 } })
  using database = outbox(payload)
  const report = readReport(7, database)

  expect(report).toMatchObject({
    id: 'orch:7',
    kind: 'review_funnel_decision',
    rowId: 'decision-record',
    recordId: 'outbox-record',
    state: 'quarantined',
    attempts: 3,
    quarantinedAt: STAMP,
    reason: 'too large',
    payloadBytes: utf8Bytes(payload),
  })
  const syncPlan = planRecordSyncBatch({
    rows: [
      {
        id: 7,
        kind: 'review_funnel_decision',
        payloadBytes: report.payloadBytes,
        serializedBytes: 0,
      },
    ],
    emptyRequestBytes: 0,
    payloadLimit: report.payloadBytes - 1,
    requestLimit: report.payloadBytes * 2,
    countLimit: 1,
  })
  expect(syncPlan.quarantine[0]?.payloadBytes).toBe(report.payloadBytes)
  expect(JSON.stringify(report)).not.toContain('known-sentinel-value')
})

test('row report measures the same project identity payload that sync checks', () => {
  const stored = JSON.stringify({
    id: 'decision-record',
    projectId: null,
    projectName: 'missing-project',
  })
  using database = outbox(stored)
  database
    .query('INSERT INTO review_funnel_decision (record_id,project_record_id) VALUES (?,NULL)')
    .run('decision-record')

  const report = readReport(7, database)
  const syncPayload = JSON.stringify({
    id: 'decision-record',
    projectId: null,
    projectName: null,
  })
  expect(report.payloadBytes).toBe(utf8Bytes(syncPayload))
})

test('row report measures a review funnel decision after sync withholds its history', () => {
  const stored = JSON.stringify({
    id: 'decision-record',
    projectId: 'project-record',
    projectName: 'fixture',
    facts: {
      branchReviews: Array.from({ length: 2_000 }, (_, index) => ({
        id: index,
        evidence: 'x'.repeat(600),
      })),
      rounds: Array.from({ length: 2_000 }, (_, index) => ({ id: index })),
    },
    withheldFields: null,
  })
  using database = outbox(stored)
  const row = readOutboxRow(database, 7)
  if (!row) throw new Error('missing fixture row')
  const prepared = outboxPayloadForRecordSync(database, row)
  const report = reportOutboxRow(row, prepared)

  expect(utf8Bytes(stored)).toBeGreaterThan(RECORD_SYNC_MAX_PAYLOAD_BYTES)
  expect(report.payloadBytes).toBe(utf8Bytes(prepared))
  expect(report.payloadBytes).toBeLessThan(RECORD_SYNC_MAX_PAYLOAD_BYTES)
})

test('sync preparation leaves other kinds byte-for-byte unchanged', () => {
  const stored = '{ "id": "run-record", "projectId": "project-record" }'
  using database = outbox(stored)
  database.query("UPDATE outbox SET kind='run'").run()
  const row = readOutboxRow(database, 7)
  if (!row) throw new Error('missing fixture row')

  expect(outboxPayloadForRecordSync(database, row)).toBe(stored)
})

test('outbox read returns no row for an unknown id', () => {
  using database = outbox('{}')
  expect(readOutboxRow(database, 8)).toBeNull()
})

test('row report refuses invalid JSON with bytes and a value-free parse error', () => {
  const payload = '{"field": known-sentinel-value}'
  using database = outbox(payload)
  const report = readReport(7, database)

  expect(report.payloadBytes).toBe(utf8Bytes(payload))
  expect(report.fields).toBeNull()
  expect(report.parseError).toContain('JSON Parse error')
  expect(JSON.stringify(report)).not.toContain('known-sentinel-value')
})
