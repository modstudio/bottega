import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { outboxRowBlockedByRetiredParent } from './outbox-dependency.ts'

test('a released lens receipt does not attach an unreadable-payload blocked reason', () => {
  const database = migratedTestDatabase()
  database
    .query(
      `INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at,retired_at,retirement_reason) VALUES
       (?1,8,'review_lens','lens-parent','','2026-09-28','2026-09-28','retired parent'),
       (?2,9,'review_finding','finding','{"reviewId":"review","reviewLensId":"lens-parent"}','2026-09-28',NULL,NULL)`,
    )
    .run(newRecordId(), newRecordId())

  expect(outboxRowBlockedByRetiredParent(database, 9)).toEqual({
    id: 9,
    kind: 'review_finding',
    parentRecordId: 'lens-parent',
  })
  database.close()
})
