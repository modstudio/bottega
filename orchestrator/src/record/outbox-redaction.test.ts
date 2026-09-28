import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import { RUN_RECORD_PAYLOAD_COLUMNS } from '../run/run-outbox.ts'
import {
  redactSyncedOutbox,
  renderSyncedRedaction,
  syncedRedactionRules,
} from './outbox-redaction.ts'
import { WITHHELD_SECRET_SHAPED } from './outbox-sanitize.ts'

const STAMP = '2026-09-28T10:00:00.000Z'
const NEXT_STAMP = '2026-09-28T10:01:00.000Z'

function plantedValues(): { urlUserinfo: string; base64: string } {
  return {
    urlUserinfo: `https://${'fixture-user'}:${'fixture-password'}@example.test/path`,
    base64: Buffer.from('runtime-created-fixture-bytes').toString('base64'),
  }
}

function runPayload(error: string, label: string): string {
  const values = Object.fromEntries(RUN_RECORD_PAYLOAD_COLUMNS.map((column) => [column, null]))
  Object.assign(values, {
    id: '01990000-0000-7000-8000-000000000042',
    promptHead: 'ordinary prompt',
    error,
    label,
    status: 'ok',
    withheldFields: [],
  })
  return JSON.stringify(values)
}

function seeded(): { database: Database; urlUserinfo: string; base64: string } {
  const database = new Database(':memory:')
  applyMigrations(database)
  const planted = plantedValues()
  database
    .query(
      `INSERT INTO run
       (id,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,error,label)
       VALUES (42,'record-42',?,'codex','implement','sha',4,'ordinary prompt','ok',?,?)`,
    )
    .run(STAMP, planted.urlUserinfo, planted.base64)
  database
    .query(
      `INSERT INTO outbox (kind,record_id,payload,created_at,synced_at)
       VALUES ('run','record-42',?,?,?)`,
    )
    .run(runPayload(planted.urlUserinfo, planted.base64), STAMP, STAMP)
  return { database, ...planted }
}

test('redaction re-enqueues only chosen-rule leaves, audits paths, and leaves local rows intact', () => {
  const { database, urlUserinfo, base64 } = seeded()
  const result = redactSyncedOutbox(
    { rules: syncedRedactionRules('url-userinfo'), dryRun: false },
    database,
    NEXT_STAMP,
  )
  expect(result).toEqual({
    counts: [{ kind: 'run', rule: 'url-userinfo', count: 1 }],
    enqueued: 1,
    wouldEnqueue: 1,
    skipped: [],
    dryRun: false,
  })
  const rows = database
    .query<{ record_id: string; payload: string; synced_at: string | null }, []>(
      'SELECT record_id,payload,synced_at FROM outbox ORDER BY id',
    )
    .all()
  expect(rows).toHaveLength(2)
  expect(rows[1]!.record_id).toBe('record-42')
  const replacement = JSON.parse(rows[1]!.payload) as Record<string, unknown>
  expect(replacement.error).toBe(WITHHELD_SECRET_SHAPED)
  expect(replacement.label).toBe(base64)
  expect(replacement.withheldFields).toEqual(['error'])
  expect(rows[1]!.payload).not.toContain(urlUserinfo)
  expect(database.query('SELECT error,label FROM run WHERE id=42').get()).toEqual({
    error: urlUserinfo,
    label: base64,
  })
  expect(
    database.query('SELECT kind,record_id,rules,withheld_paths FROM outbox_redaction_audit').get(),
  ).toEqual({
    kind: 'run',
    record_id: 'record-42',
    rules: '["url-userinfo"]',
    withheld_paths: '["error"]',
  })
  database.close()
})

test('a redacted row is a no-op after it syncs', () => {
  const { database } = seeded()
  const options = { rules: syncedRedactionRules('url-userinfo'), dryRun: false }
  redactSyncedOutbox(options, database, NEXT_STAMP)
  database.query('UPDATE outbox SET synced_at=? WHERE synced_at IS NULL').run(NEXT_STAMP)
  expect(redactSyncedOutbox(options, database, '2026-09-28T10:02:00.000Z')).toEqual({
    counts: [],
    enqueued: 0,
    wouldEnqueue: 0,
    skipped: [],
    dryRun: false,
  })
  expect(database.query('SELECT count(*) AS count FROM outbox').get()).toEqual({ count: 2 })
  expect(database.query('SELECT count(*) AS count FROM outbox_redaction_audit').get()).toEqual({
    count: 1,
  })
  database.close()
})

test('dry run reports what it would enqueue and writes nothing', () => {
  const { database } = seeded()
  const before = database.query('SELECT count(*) AS count FROM outbox').get()
  const result = redactSyncedOutbox(
    { rules: syncedRedactionRules(), dryRun: true },
    database,
    NEXT_STAMP,
  )
  expect(result.enqueued).toBe(0)
  expect(result.wouldEnqueue).toBe(1)
  expect(database.query('SELECT count(*) AS count FROM outbox').get()).toEqual(before)
  expect(database.query('SELECT count(*) AS count FROM outbox_redaction_audit').get()).toEqual({
    count: 0,
  })
  database.close()
})

test('a newer active row is skipped and reported without leaking planted text', () => {
  const { database, urlUserinfo } = seeded()
  database
    .query(
      `INSERT INTO outbox (kind,record_id,payload,created_at)
       VALUES ('run','record-42',?,?)`,
    )
    .run(runPayload('a newer clean value', 'ordinary label'), NEXT_STAMP)
  const result = redactSyncedOutbox(
    { rules: syncedRedactionRules('url-userinfo'), dryRun: false },
    database,
    '2026-09-28T10:02:00.000Z',
  )
  expect(result.skipped).toEqual([{ kind: 'run', recordId: 'record-42' }])
  expect(result.enqueued).toBe(0)
  expect(result.wouldEnqueue).toBe(0)
  expect(database.query('SELECT count(*) AS count FROM outbox').get()).toEqual({ count: 2 })
  expect(database.query('SELECT count(*) AS count FROM outbox_redaction_audit').get()).toEqual({
    count: 0,
  })
  expect(JSON.stringify(result)).not.toContain(urlUserinfo)
  expect(renderSyncedRedaction(result)).not.toContain(urlUserinfo)
  expect(renderSyncedRedaction(result)).toContain('skipped\trun\trecord-42')
  database.close()
})

test('redaction audit is append-only', () => {
  const { database } = seeded()
  redactSyncedOutbox(
    { rules: syncedRedactionRules('url-userinfo'), dryRun: false },
    database,
    NEXT_STAMP,
  )
  expect(() => database.query("UPDATE outbox_redaction_audit SET rules='[]'").run()).toThrow(
    'outbox redaction audit is append-only',
  )
  expect(() => database.query('DELETE FROM outbox_redaction_audit').run()).toThrow(
    'outbox redaction audit is append-only',
  )
  database.close()
})

test('rules option accepts only the operator-approved redaction rules', () => {
  expect([...syncedRedactionRules()]).toEqual([
    'url-userinfo',
    'bearer',
    'authorization',
    'provider-prefix',
    'assignment',
  ])
  expect(() => syncedRedactionRules('base64')).toThrow('not approved for synced redaction')
  expect(() => syncedRedactionRules('hex-run')).toThrow('not approved for synced redaction')
})
