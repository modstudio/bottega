import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { HostedBoardMessage } from '../record/record-board-contract.ts'
import { takeHostedReportReplySuccessor } from './board-hosted-successor.ts'

test('a lost election caches the hosted successor holder', async () => {
  const database = migratedTestDatabase()
  const message = {
    id: newRecordId(),
    kind: 'reply',
    threadRootId: newRecordId(),
  } as HostedBoardMessage
  database
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(message.id, message.kind, message.threadRootId, '1', JSON.stringify(message))
  const client = {
    ...createMemoryRecordApiClient(),
    takeBoardSuccessor: async () => ({ elected: false, holder: 'other-holder' }),
  }

  expect(
    await takeHostedReportReplySuccessor({
      message,
      database,
      reader: 'candidate',
      readerUserId: 'user-a',
      readerRunRecordId: newRecordId(),
      client,
    }),
  ).toBe(false)
  expect(
    database
      .query(
        `SELECT reader_session,reader_run_record_id,audience_at_posting,delivered_at,
                acknowledged_at,successor
         FROM hosted_board_receipt_cache WHERE message_id=?`,
      )
      .get(message.id),
  ).toEqual({
    reader_session: 'other-holder',
    reader_run_record_id: null,
    audience_at_posting: 0,
    delivered_at: null,
    acknowledged_at: null,
    successor: 1,
  })
})
