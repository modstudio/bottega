// concern: hosted-board-read-cache
/** Stores the local mirror of a successor holder elected by the hosted record. */

import type { Database } from 'bun:sqlite'
import type { RecordApiClient } from '../record/record-api-client.ts'
import type { HostedBoardMessage } from '../record/record-board-contract.ts'
import { cacheHostedBoardReceipt } from './board-hosted-receipt-cache.ts'

export async function takeHostedReportReplySuccessor(input: {
  message: HostedBoardMessage
  database: Database
  reader: string
  readerUserId: string
  readerRunRecordId: string | null
  client: RecordApiClient
}): Promise<boolean> {
  const result = await input.client.takeBoardSuccessor({
    messageId: input.message.id,
    candidateSession: input.reader,
  })
  if (result.holder !== input.reader) return false
  cacheHostedBoardReceipt(
    {
      messageId: input.message.id,
      readerUserId: input.readerUserId,
      readerSession: input.reader,
      readerRunRecordId: input.readerRunRecordId,
      audienceAtPosting: false,
      deliveredAt: null,
      acknowledgedAt: null,
      successor: true,
    },
    input.database,
  )
  return true
}
