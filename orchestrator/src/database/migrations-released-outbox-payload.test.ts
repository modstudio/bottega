import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from '../record/outbox-payload-contracts.ts'
import { RELEASED_OUTBOX_PAYLOAD } from '../record/outbox-prune-payload.ts'
import { applyMigrations, migrationJournal } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

// Applying any pending migration re-executes every compatible backfill, so each one must
// tolerate the empty payload a delivered outbox row keeps once the record has held it.
test('re-executed backfills tolerate released outbox payloads', () => {
  const newest = migrationJournal().at(-1)!.tag
  const database = migrationBoundaryTestDatabase(newest)
  try {
    const insert = database.query(
      `INSERT INTO outbox (record_id,kind,row_id,payload,created_at)
       VALUES (?,?,?,?, '2026-11-06T00:00:00.000Z')`,
    )
    for (const kind of Object.keys(OUTBOX_PAYLOAD_CONTRACTS)) {
      insert.run(newRecordId(), kind, newRecordId(), RELEASED_OUTBOX_PAYLOAD)
    }

    const dirtyRecordId = newRecordId()
    insert.run(
      dirtyRecordId,
      'run',
      newRecordId(),
      JSON.stringify({
        outsideWorktreeWrites: [
          {
            project: 'sample',
            path: '/tmp/sample',
            before: '',
            after: 'tracked.txt\0untracked.txt',
          },
        ],
      }),
    )

    expect(applyMigrations(database)).toContain(newest)

    const releasedPayloads = database
      .query<{ payload: string }, [string]>(
        'SELECT payload FROM outbox WHERE record_id<>? ORDER BY kind',
      )
      .all(dirtyRecordId)
    expect(releasedPayloads).toHaveLength(Object.keys(OUTBOX_PAYLOAD_CONTRACTS).length)
    expect(releasedPayloads.every(({ payload }) => payload === RELEASED_OUTBOX_PAYLOAD)).toBe(true)

    const dirtyPayload = database
      .query<{ payload: string }, [string]>('SELECT payload FROM outbox WHERE record_id=?')
      .get(dirtyRecordId)!.payload
    const outsideWorktreeWrites = JSON.parse(dirtyPayload).outsideWorktreeWrites as {
      after: string
    }[]
    expect(outsideWorktreeWrites[0]!.after).toBe('tracked.txt\nuntracked.txt')
    expect(outsideWorktreeWrites.some(({ after }) => after.includes('\0'))).toBe(false)
  } finally {
    database.close()
  }
})
