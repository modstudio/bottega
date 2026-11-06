import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { pruneSupersededOutboxRows, releaseDeliveredOutboxPayloads } from './outbox-prune.ts'
import { OUTBOX_PAYLOAD_RETENTION_MS, RELEASED_OUTBOX_PAYLOAD } from './outbox-prune-payload.ts'
import { supersededOutboxSelectionSql } from './outbox-prune-query.ts'
import { localQuestionCountForSpace } from './record-doctor.ts'
import { applyRecordSyncBatchResults } from './record-sync-results.ts'
import type { OutboxRow } from './record-sync-types.ts'

const STAMP = '2026-11-05T12:00:00.000Z'

function addRow(
  database: Database,
  identity: string,
  state: 'delivered' | 'pending' | 'quarantined' | 'retired',
  kind = 'run',
): number {
  const result = database
    .query(
      `INSERT INTO outbox
       (record_id,kind,row_id,payload,created_at,synced_at,quarantined_at,retired_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      newRecordId(),
      kind,
      identity,
      JSON.stringify({ identity, state }),
      STAMP,
      state === 'delivered' ? STAMP : null,
      state === 'quarantined' ? STAMP : null,
      state === 'retired' ? STAMP : null,
    )
  return Number(result.lastInsertRowid)
}

function ids(database: Database): number[] {
  return database
    .query<{ id: number }, []>('SELECT id FROM outbox ORDER BY id')
    .all()
    .map((row) => row.id)
}

function audit(
  database: Database,
  table: 'outbox_quarantine_audit' | 'outbox_redaction_audit',
  outboxId: number,
): void {
  if (table === 'outbox_quarantine_audit') {
    database
      .query(
        `INSERT INTO outbox_quarantine_audit
         (record_id,outbox_id,kind,row_id,attempts,disposition,at)
         VALUES (?,?,'run','audited',0,'quarantine',?)`,
      )
      .run(newRecordId(), outboxId, STAMP)
    return
  }
  database
    .query(
      `INSERT INTO outbox_redaction_audit
       (record_id,outbox_id,kind,row_id,rules,withheld_paths,at)
       VALUES (?,?,'run','audited','[]','[]',?)`,
    )
    .run(newRecordId(), outboxId, STAMP)
}

test('prune removes only unaudited superseded delivered history', () => {
  const database = migratedTestDatabase()
  const old = addRow(database, 'ordinary', 'delivered')
  const latest = addRow(database, 'ordinary', 'delivered')
  const pendingIdentityOld = addRow(database, 'with-pending', 'delivered')
  const pendingIdentityLatest = addRow(database, 'with-pending', 'delivered')
  const pendingNewer = addRow(database, 'with-pending', 'pending')
  const pending = addRow(database, 'pending', 'pending')
  const quarantined = addRow(database, 'quarantined', 'quarantined')
  const retired = addRow(database, 'retired', 'retired')
  const quarantineAudited = addRow(database, 'audited', 'delivered')
  const redactionAudited = addRow(database, 'audited', 'delivered')
  const auditedLatest = addRow(database, 'audited', 'delivered')
  audit(database, 'outbox_quarantine_audit', quarantineAudited)
  audit(database, 'outbox_redaction_audit', redactionAudited)

  expect(ids(database)).toHaveLength(11)
  expect(pruneSupersededOutboxRows(database, { limit: 100 })).toEqual({ deleted: 2, more: false })
  expect(ids(database)).toEqual([
    latest,
    pendingIdentityLatest,
    pendingNewer,
    pending,
    quarantined,
    retired,
    quarantineAudited,
    redactionAudited,
    auditedLatest,
  ])
  expect(ids(database)).not.toContain(old)
  expect(ids(database)).not.toContain(pendingIdentityOld)
  database.close()
})

test('prune honors its limit and reports remaining eligible rows', () => {
  const database = migratedTestDatabase()
  addRow(database, 'one', 'delivered')
  addRow(database, 'one', 'delivered')
  addRow(database, 'two', 'delivered')
  addRow(database, 'two', 'delivered')
  expect(pruneSupersededOutboxRows(database, { limit: 1 })).toEqual({ deleted: 1, more: true })
  expect(ids(database)).toHaveLength(3)
  expect(pruneSupersededOutboxRows(database, { limit: 1 })).toEqual({ deleted: 1, more: false })
  expect(ids(database)).toHaveLength(2)
  database.close()
})

test('prune selection walks candidate rows without sorting', () => {
  const database = migratedTestDatabase()
  const details = database
    .query<{ detail: string }, [number]>(
      `EXPLAIN QUERY PLAN ${supersededOutboxSelectionSql(false)}`,
    )
    .all(1)
    .map((row) => row.detail)
  expect(details).not.toContain('USE TEMP B-TREE FOR ORDER BY')
  expect(details.some((detail) => /SEARCH newer .*outbox_latest_synced_row/.test(detail))).toBe(
    true,
  )
  database.close()
})

test('dry-run reports the full selection without deleting it', () => {
  const database = migratedTestDatabase()
  addRow(database, 'one', 'delivered')
  addRow(database, 'one', 'delivered')
  addRow(database, 'two', 'delivered')
  addRow(database, 'two', 'delivered')
  expect(pruneSupersededOutboxRows(database, { limit: 1, dryRun: true })).toEqual({
    deleted: 2,
    more: true,
  })
  expect(ids(database)).toHaveLength(4)
  database.close()
})

test('dry-run uses a read-only handle without taking a write transaction', () => {
  const directory = mkdtempSync(join(tmpdir(), 'outbox-prune-readonly-'))
  const path = join(directory, 'store.db')
  const writable = migratedTestDatabase()
  addRow(writable, 'readonly', 'delivered')
  addRow(writable, 'readonly', 'delivered')
  writeFileSync(path, writable.serialize())
  writable.close()
  const readonly = new Database(path, { readonly: true })
  try {
    expect(pruneSupersededOutboxRows(readonly, { limit: 1, dryRun: true })).toEqual({
      deleted: 1,
      more: true,
    })
  } finally {
    readonly.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('payload release honors its window, protected states, audits, and idempotence', () => {
  const database = migratedTestDatabase()
  const now = Date.parse('2026-11-05T12:00:00.000Z')
  const outside = addRow(database, 'outside', 'delivered')
  const inside = addRow(database, 'inside', 'delivered')
  const quarantined = addRow(database, 'quarantined-release', 'quarantined')
  const retired = addRow(database, 'retired-release', 'retired')
  const pending = addRow(database, 'pending-release', 'pending')
  const quarantineAudited = addRow(database, 'quarantine-audited-release', 'delivered')
  const redactionAudited = addRow(database, 'redaction-audited-release', 'delivered')
  database
    .query('UPDATE outbox SET synced_at=? WHERE id=?')
    .run(new Date(now - OUTBOX_PAYLOAD_RETENTION_MS - 1).toISOString(), outside)
  database
    .query('UPDATE outbox SET synced_at=? WHERE id=?')
    .run(new Date(now - OUTBOX_PAYLOAD_RETENTION_MS + 1).toISOString(), inside)
  database
    .query('UPDATE outbox SET synced_at=? WHERE id IN (?,?)')
    .run(STAMP, quarantineAudited, redactionAudited)
  audit(database, 'outbox_quarantine_audit', quarantineAudited)
  audit(database, 'outbox_redaction_audit', redactionAudited)

  expect(releaseDeliveredOutboxPayloads(database, { now, limit: 100, dryRun: true })).toEqual({
    released: 1,
    more: true,
  })
  expect(releaseDeliveredOutboxPayloads(database, { now, limit: 100 })).toEqual({
    released: 1,
    more: false,
  })
  expect(
    database
      .query<{ payload: string }, [number]>('SELECT payload FROM outbox WHERE id=?')
      .get(outside)!.payload,
  ).toBe(RELEASED_OUTBOX_PAYLOAD)
  for (const id of [inside, quarantined, retired, pending, quarantineAudited, redactionAudited]) {
    expect(
      database
        .query<{ payload: string }, [number]>('SELECT payload FROM outbox WHERE id=?')
        .get(id)!.payload,
    ).not.toBe(RELEASED_OUTBOX_PAYLOAD)
  }
  expect(releaseDeliveredOutboxPayloads(database, { now, limit: 100 })).toEqual({
    released: 0,
    more: false,
  })
  database.close()
})

test('acknowledgement prunes earlier delivered rows for that identity only', () => {
  const database = migratedTestDatabase()
  const earlier = addRow(database, 'target', 'delivered')
  const pending = addRow(database, 'target', 'pending')
  const otherEarlier = addRow(database, 'other', 'delivered')
  addRow(database, 'other', 'delivered')
  const row = database
    .query<OutboxRow, [number]>('SELECT id,kind,row_id,payload FROM outbox WHERE id=?')
    .get(pending)!

  expect(
    applyRecordSyncBatchResults({
      local: database,
      batch: [{ id: row.id, kind: row.kind, payload: row.payload, spaceHint: null }],
      localRows: new Map([[row.id, row]]),
      dependencies: [{ id: row.id, sameBatchParentIdGroups: [] }],
      response: { results: [{ id: row.id, status: 'synced' }] },
      attempted: new Set(),
      readOnlyDeferred: new Map(),
      held: new Map(),
      now: () => STAMP,
    }),
  ).toEqual({ pushed: 1, failed: 0 })
  expect(ids(database)).not.toContain(earlier)
  expect(ids(database)).toContain(pending)
  expect(ids(database)).toContain(otherEarlier)
  database.close()
})

test("record doctor's synced-run existence predicate survives pruning", () => {
  const database = migratedTestDatabase()
  database
    .query(
      `INSERT INTO run
       (number,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,task_record_id)
       VALUES (1,'doctor-run',?,'codex','implement','sha',3,'ask','asking','fixture-task')`,
    )
    .run(STAMP)
  database
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question)
       VALUES (1,?,'doctor-run',?,'question')`,
    )
    .run(newRecordId(), STAMP)
  addRow(database, 'doctor-run', 'delivered')
  addRow(database, 'doctor-run', 'delivered')
  expect(pruneSupersededOutboxRows(database, { limit: 100 }).deleted).toBe(1)
  expect(localQuestionCountForSpace(database, [], { id: 'space', slug: 'space' })).toBe(1)
  database.close()
})
