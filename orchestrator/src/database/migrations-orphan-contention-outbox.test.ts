import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations, applyMigrationsBefore } from './migrations.ts'

test('contention outbox migration removes only safe delivered orphans', () => {
  const database = new Database(':memory:')
  applyMigrationsBefore(database, '0206_orphan_contention_outbox')
  const live = newRecordId()
  database
    .query(
      `INSERT INTO contention (record_id,at,resource_kind,resource_key,event_kind)
       VALUES (?,'2026-11-01T00:00:00.000Z','cpu','live','wait')`,
    )
    .run(live)
  const insert = database.query(
    `INSERT INTO outbox
     (record_id,kind,row_id,payload,created_at,synced_at,quarantined_at,retired_at)
     VALUES (?,'contention',?,'{}','2026-11-01T00:00:00.000Z',?,?,?)`,
  )
  const orphan = newRecordId()
  const quarantined = newRecordId()
  const retired = newRecordId()
  const pending = newRecordId()
  const audited = newRecordId()
  insert.run(newRecordId(), live, '2026-11-01T00:01:00.000Z', null, null)
  insert.run(newRecordId(), orphan, '2026-11-01T00:01:00.000Z', null, null)
  insert.run(
    newRecordId(),
    quarantined,
    '2026-11-01T00:01:00.000Z',
    '2026-11-01T00:02:00.000Z',
    null,
  )
  insert.run(newRecordId(), retired, '2026-11-01T00:01:00.000Z', null, '2026-11-01T00:02:00.000Z')
  insert.run(newRecordId(), pending, null, null, null)
  const auditedId = Number(
    insert.run(newRecordId(), audited, '2026-11-01T00:01:00.000Z', null, null).lastInsertRowid,
  )
  database
    .query(
      `INSERT INTO outbox_redaction_audit
       (record_id,outbox_id,kind,row_id,rules,withheld_paths,at)
       VALUES (?,?,'contention',?,'[]','[]','2026-11-01T00:02:00.000Z')`,
    )
    .run(newRecordId(), auditedId, audited)

  expect(applyMigrations(database)).toContain('0206_orphan_contention_outbox')
  expect(
    database
      .query<{ row_id: string }, []>(
        "SELECT row_id FROM outbox WHERE kind='contention' ORDER BY id",
      )
      .all()
      .map((row) => row.row_id),
  ).toEqual([live, quarantined, retired, pending, audited])
  database.close()
})
