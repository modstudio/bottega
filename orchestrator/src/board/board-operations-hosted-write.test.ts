import { beforeEach, expect, test } from 'bun:test'
import {
  boardDuplicateWarning,
  boardReplyDuplicateWarning,
} from '../../../shared/board-write-result.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'
import { boardAsk, boardPost, boardReply } from './board-operations.ts'

const env = {
  CLAUDE_CODE_SESSION_ID: 'board-route-session',
  BOTTEGA_RECORD_API_URL: 'https://record.test',
}
const destinationResolver = async () => ({ destinationSpaceId: 'space:personal' })
const hostedMessage = (id = newRecordId()) => ({
  id,
  kind: 'notice',
  threadRootId: null,
  title: 'Hosted',
  body: 'body',
  audience: 'operator',
  origin: {
    kind: 'architect',
    session: env.CLAUDE_CODE_SESSION_ID,
    harness: 'claude',
    project: null,
    runId: null,
  },
  senderTags: [],
  createdAt: '2026-10-05T12:00:00.000Z',
  expiresAt: '2026-10-06T12:00:00.000Z',
  withdrawnAt: null,
  state: 'open',
  acceptedReplyId: null,
  acceptedBy: null,
  acceptedAt: null,
  noteId: null,
  notePendingError: null,
  revision: '1',
  scopeProjectIds: [],
  recipientUserIds: [],
  claimId: null,
  authorUserId: newRecordId(),
  authorSession: env.CLAUDE_CODE_SESSION_ID,
  ackRequired: false,
  ackDeadline: null,
})

beforeEach(() => {
  db()
    .query('INSERT OR REPLACE INTO schema_meta(key,value) VALUES (?,?)')
    .run(BOARD_HOSTED_ADOPTED_KEY, '1')
})

test('hosted writes map duplicate and fresh server responses', async () => {
  const root = hostedMessage()
  const existingReplyId = newRecordId()
  let replyAudience: { kind: string } | undefined
  const client = {
    ...createMemoryRecordApiClient(),
    postBoardMessage: async (input: { id: string; kind: string }) =>
      input.kind === 'notice'
        ? { ...root, duplicateOf: root.id }
        : { ...hostedMessage(input.id), kind: 'question', duplicateOf: null },
    replyBoardMessage: async (
      rootId: string,
      input: { id: string; audience?: { kind: string } },
    ) => {
      replyAudience = input.audience
      return {
        ...hostedMessage(existingReplyId),
        kind: 'reply',
        threadRootId: rootId,
        duplicateOf: existingReplyId,
      }
    },
  }
  const posted = await boardPost(
    { audience: 'operator', title: 'Hosted', body: 'body' },
    { env, client, destinationResolver },
  )
  expect({ ...posted, dropped: Boolean(posted.dropped) }).toEqual({
    recordId: root.id,
    number: null,
    dropped: true,
    reached: null,
    warning: boardDuplicateWarning(root.id),
  })
  const asked = await boardAsk(
    { audience: 'operator', title: 'Hosted question', body: 'body' },
    { env, client, destinationResolver },
  )
  expect(Boolean(asked.dropped)).toBeFalse()
  expect(asked.warning).toBeNull()
  const replied = await boardReply(
    root.id,
    'reply',
    { env, client, destinationResolver },
    { kind: 'acknowledged' },
  )
  expect({ ...replied, dropped: Boolean(replied.dropped) }).toEqual({
    recordId: existingReplyId,
    number: null,
    rootId: root.id,
    dropped: true,
    reached: null,
    warning: boardReplyDuplicateWarning(existingReplyId, root.id),
  })
  expect(replyAudience).toEqual({ kind: 'acknowledged' })
})
