import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { closeOutSessionOutbox, readSessionOutboxResidue } from './session-close-out-outbox.ts'

test('close-out outbox count ignores another session and unattributed rows', () => {
  const database = new Database(':memory:')
  database.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY,
    actor_session TEXT,
    synced_at TEXT,
    quarantined_at TEXT,
    retired_at TEXT
  )`)
  const insert = database.query(
    `INSERT INTO outbox (id,actor_session,synced_at,quarantined_at,retired_at)
     VALUES (?,?,?,?,?)`,
  )
  insert.run(1, 'owner', null, null, null)
  insert.run(2, 'owner', null, '2026-11-09T10:00:00.000Z', null)
  insert.run(3, 'other', null, null, null)
  insert.run(4, null, null, null, null)

  expect(readSessionOutboxResidue(database, 'owner')).toEqual({
    pendingIds: [1],
    quarantinedIds: [2],
  })
  database.close()
})

test('dry-run reports this session residue without pushing', async () => {
  const database = new Database(':memory:')
  database.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY,
    actor_session TEXT,
    synced_at TEXT,
    quarantined_at TEXT,
    retired_at TEXT
  );
  INSERT INTO outbox VALUES (1, 'owner', NULL, NULL, NULL);
  INSERT INTO outbox VALUES (2, 'owner', NULL, '2026-11-09T10:00:00.000Z', NULL);`)

  expect(await closeOutSessionOutbox({ database, session: 'owner', dryRun: true })).toEqual({
    mechanical: [],
    process: [
      {
        item: '1 pending outbox write(s)',
        reason: 'this session has local writes that have not reached the hosted record',
        evidence: 'orch:1',
        remedy: `${PLATFORM_SLUG} record push`,
      },
      {
        item: '1 quarantined outbox write(s)',
        reason: 'this session has hosted writes quarantined after delivery failed',
        evidence: 'orch:2',
        remedy: `inspect with ${PLATFORM_SLUG} record outbox; retry each row with ${PLATFORM_SLUG} record outbox retry orch:<row-id>`,
      },
    ],
    errors: [],
  })
  database.close()
})
