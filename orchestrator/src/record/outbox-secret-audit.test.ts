import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import { RUN_RECORD_PAYLOAD_COLUMNS } from '../run/run-outbox.ts'
import { auditOutboxSecrets, renderOutboxSecretAudit } from './outbox-secret-audit.ts'

const SECRET = 'ghp_123456789012345678901234567890123456'
const STAMP = '2026-09-15T01:01:00.000Z'

function runPayload(error: string): string {
  const values = Object.fromEntries(RUN_RECORD_PAYLOAD_COLUMNS.map((column) => [column, null]))
  Object.assign(values, {
    id: '01990000-0000-7000-8000-000000000042',
    promptHead: 'head',
    error,
    status: 'ok',
  })
  return JSON.stringify(values)
}

function seeded(): Database {
  const database = new Database(':memory:')
  applyMigrations(database)
  const secret = runPayload(SECRET)
  database
    .query(
      `INSERT INTO outbox (id,kind,record_id,payload,created_at,synced_at,quarantined_at,retired_at)
       VALUES (1,'run','r1',?,?,'2026-09-15T01:02:00.000Z',NULL,NULL),
              (2,'run','r2',?,?,NULL,NULL,NULL),
              (3,'run','r3',?,?,NULL,'2026-09-15T01:03:00.000Z',NULL),
              (4,'run','r4',?,?,NULL,NULL,'2026-09-15T01:04:00.000Z'),
              (5,'run','r5',?,?,NULL,NULL,NULL)`,
    )
    .run(secret, STAMP, secret, STAMP, secret, STAMP, secret, STAMP, runPayload('clean'), STAMP)
  return database
}

test('audit counts kind x first-matching rule x status and never includes matched text', () => {
  const database = seeded()
  const report = auditOutboxSecrets(database)
  expect(report).toEqual({
    counts: [
      { kind: 'run', rule: 'provider-prefix', status: 'pending', count: 1 },
      { kind: 'run', rule: 'provider-prefix', status: 'quarantined', count: 1 },
      { kind: 'run', rule: 'provider-prefix', status: 'retired', count: 1 },
      { kind: 'run', rule: 'provider-prefix', status: 'synced', count: 1 },
    ],
  })
  const json = JSON.stringify(report)
  expect(json).not.toContain(SECRET)
  expect(json).not.toMatch(/"error"/)
  const text = renderOutboxSecretAudit(report)
  expect(text).toBe(
    [
      'run\tprovider-prefix\tpending\t1',
      'run\tprovider-prefix\tquarantined\t1',
      'run\tprovider-prefix\tretired\t1',
      'run\tprovider-prefix\tsynced\t1',
    ].join('\n'),
  )
  expect(text).not.toContain(SECRET)
  database.close()
})

test('audit --ids is the only way outbox ids appear', () => {
  const database = seeded()
  expect(JSON.stringify(auditOutboxSecrets(database))).not.toMatch(/"ids"/)
  const withIds = auditOutboxSecrets(database, { ids: true })
  expect(withIds.counts.map((row) => row.ids)).toEqual([[2], [3], [4], [1]])
  expect(renderOutboxSecretAudit(withIds)).toContain('\t1')
  database.close()
})
