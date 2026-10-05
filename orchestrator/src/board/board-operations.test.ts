import { beforeEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'
import {
  boardAccept,
  boardAcknowledge,
  boardClaimRelease,
  boardClaimRenew,
  boardFileNote,
  boardPost,
  boardReply,
  boardStatus,
  boardThread,
  boardWithdraw,
} from './board-operations.ts'

const env = {
  CLAUDE_CODE_SESSION_ID: 'board-route-session',
  ORCH_RECORD_API_URL: 'https://record.test',
}

beforeEach(() => {
  db().query('DELETE FROM schema_meta WHERE key=?').run(BOARD_HOSTED_ADOPTED_KEY)
  db().query('DELETE FROM board_message').run()
})

test('an unadopted install keeps a post local and renders its id as a string', async () => {
  const result = await boardPost(
    { audience: 'operator', title: 'Local', body: 'unchanged' },
    {
      env: { ORCH_RECORD_API_URL: env.ORCH_RECORD_API_URL },
      clock: Date.parse('2026-10-05T12:00:00Z'),
      cwd: process.cwd(),
    },
  )
  expect(result.id).toBeString()
  expect(
    db().query<{ count: number }, []>('SELECT count(*) count FROM board_message').get()?.count,
  ).toBe(1)
})

test('an adopted install routes hosted-capable message verbs only to the injected client', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const id = newRecordId()
  const calls: string[] = []
  const message = {
    id,
    kind: 'notice',
    title: 'Hosted',
    body: 'body',
    audience: 'operator',
    origin: {
      kind: 'architect',
      session: 'board-route-session',
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
    authorSession: 'board-route-session',
    ackRequired: false,
    ackDeadline: null,
  }
  const client = {
    ...createMemoryRecordApiClient(),
    postBoardMessage: async (input: { id: string }) => {
      calls.push('post')
      return { ...message, id: input.id }
    },
    replyBoardMessage: async () => {
      calls.push('reply')
      return message
    },
    withdrawBoardMessage: async () => {
      calls.push('withdraw')
      return message
    },
    getBoardThread: async () => {
      calls.push('thread')
      return { root: message, replies: [] }
    },
    getBoardStatus: async () => {
      calls.push('status')
      return { message, receipts: [] }
    },
    putBoardReceipt: async (input: {
      messageId: string
      readerSession: string
      audienceAtPosting: boolean
    }) => {
      calls.push('ack')
      return {
        messageId: input.messageId,
        readerUserId: newRecordId(),
        readerSession: input.readerSession,
        audienceAtPosting: input.audienceAtPosting,
        deliveredAt: null,
        acknowledgedAt: '2026-10-05T12:00:00.000Z',
      }
    },
  }
  await boardPost({ audience: 'operator', title: 'Hosted', body: 'body' }, { env, client })
  await boardReply(id, 'reply', { env, client })
  await boardWithdraw(id, { env, client })
  await boardThread(id, { env, client })
  await boardStatus(id, { env, client })
  await boardAcknowledge(id, { env, client })
  expect(calls).toEqual(['post', 'reply', 'withdraw', 'thread', 'status', 'ack'])
  expect(
    db().query<{ count: number }, []>('SELECT count(*) count FROM board_message').get()?.count,
  ).toBe(0)
})

test('machine audiences stay local after adoption and ids are validated for the selected mode', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const client = createMemoryRecordApiClient()
  const local = await boardPost(
    { audience: 'machine:host', title: 'Machine', body: 'local' },
    { env: { ORCH_RECORD_API_URL: env.ORCH_RECORD_API_URL }, client },
  )
  expect(local.id).toMatch(/^\d+$/)
  await expect(boardThread(local.id, { env, client })).rejects.toThrow(
    /not readable by this session/,
  )
})

test('an adopted install routes every positive-integer id only to the local service', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  let hostedCalls = 0
  const hostedUnexpected = async (): Promise<never> => {
    hostedCalls += 1
    throw new Error('hosted service was called')
  }
  const client = {
    ...createMemoryRecordApiClient(),
    replyBoardMessage: hostedUnexpected,
    withdrawBoardMessage: hostedUnexpected,
    getBoardThread: hostedUnexpected,
    getBoardStatus: hostedUnexpected,
    putBoardReceipt: hostedUnexpected,
    acceptBoardAnswer: hostedUnexpected,
    takeBoardFilingLease: hostedUnexpected,
    renewBoardClaim: hostedUnexpected,
    releaseBoardClaim: hostedUnexpected,
  }
  const localId = '999999'
  const operations: [() => Promise<unknown>, RegExp][] = [
    [() => boardReply(localId, 'reply', { env, client }), /no board message/],
    [() => boardThread(localId, { env, client }), /no board message/],
    [() => boardWithdraw(localId, { env, client }), /no board notice/],
    [() => boardAcknowledge(localId, { env, client }), /not addressed to this reader/],
    [() => boardStatus(localId, { env, client }), /no board notice/],
    [() => boardAccept(localId, localId, { env, client }), /no board message/],
    [() => boardFileNote(localId, { env, client }), /no board message/],
    [() => boardClaimRenew(localId, { env, client }), /no board claim/],
    [() => boardClaimRelease(localId, { env, client }), /no board claim/],
  ]
  for (const [operation, expected] of operations)
    await expect(operation()).rejects.toThrow(expected)
  expect(hostedCalls).toBe(0)
})

test('an adopted install routes every UUID id only to the hosted client', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  let hostedCalls = 0
  const hostedReached = async (): Promise<never> => {
    hostedCalls += 1
    throw new Error('hosted service reached')
  }
  const client = {
    ...createMemoryRecordApiClient(),
    replyBoardMessage: hostedReached,
    withdrawBoardMessage: hostedReached,
    getBoardThread: hostedReached,
    getBoardStatus: hostedReached,
    putBoardReceipt: hostedReached,
    acceptBoardAnswer: hostedReached,
    takeBoardFilingLease: hostedReached,
    renewBoardClaim: hostedReached,
    releaseBoardClaim: hostedReached,
  }
  const id = newRecordId()
  const operations = [
    () => boardReply(id, 'reply', { env, client }),
    () => boardThread(id, { env, client }),
    () => boardWithdraw(id, { env, client }),
    () => boardAcknowledge(id, { env, client }),
    () => boardStatus(id, { env, client }),
    () => boardAccept(id, id, { env, client }),
    () => boardFileNote(id, { env, client }),
    () => boardClaimRenew(id, { env, client }),
    () => boardClaimRelease(id, { env, client }),
  ]
  for (const operation of operations)
    await expect(operation()).rejects.toThrow('hosted service reached')
  expect(hostedCalls).toBe(operations.length)
})

test('an unadopted install refuses every UUID id before calling either store', async () => {
  let hostedCalls = 0
  const hostedUnexpected = async (): Promise<never> => {
    hostedCalls += 1
    throw new Error('hosted service was called')
  }
  const client = {
    ...createMemoryRecordApiClient(),
    replyBoardMessage: hostedUnexpected,
    withdrawBoardMessage: hostedUnexpected,
    getBoardThread: hostedUnexpected,
    getBoardStatus: hostedUnexpected,
    putBoardReceipt: hostedUnexpected,
    acceptBoardAnswer: hostedUnexpected,
    takeBoardFilingLease: hostedUnexpected,
    renewBoardClaim: hostedUnexpected,
    releaseBoardClaim: hostedUnexpected,
  }
  const id = newRecordId()
  const operations = [
    () => boardReply(id, 'reply', { env, client }),
    () => boardThread(id, { env, client }),
    () => boardWithdraw(id, { env, client }),
    () => boardAcknowledge(id, { env, client }),
    () => boardStatus(id, { env, client }),
    () => boardAccept(id, id, { env, client }),
    () => boardFileNote(id, { env, client }),
    () => boardClaimRenew(id, { env, client }),
    () => boardClaimRelease(id, { env, client }),
  ]
  for (const operation of operations)
    await expect(operation()).rejects.toThrow('has not adopted the hosted board')
  expect(hostedCalls).toBe(0)
})

test('hosted acknowledgement uses the reserved operator reader without a session', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const id = newRecordId()
  let readerSession: string | undefined
  const client = {
    ...createMemoryRecordApiClient(),
    putBoardReceipt: async (
      input: Parameters<ReturnType<typeof createMemoryRecordApiClient>['putBoardReceipt']>[0],
    ) => {
      readerSession = input.readerSession
      return {
        messageId: input.messageId,
        readerUserId: newRecordId(),
        readerSession: input.readerSession,
        audienceAtPosting: input.audienceAtPosting,
        deliveredAt: null,
        acknowledgedAt: '2026-10-05T12:00:00.000Z',
      }
    },
  }
  await expect(
    boardAcknowledge(id, { env: { ORCH_RECORD_API_URL: env.ORCH_RECORD_API_URL }, client }),
  ).resolves.toEqual({ acknowledged: id })
  expect(readerSession).toBe('operator')
})

test('an adopted install without hosted configuration refuses instead of writing locally', async () => {
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  await expect(
    boardPost(
      { audience: 'operator', title: 'No fallback', body: 'body' },
      { env: { CLAUDE_CODE_SESSION_ID: 'board-route-session' } },
    ),
  ).rejects.toThrow('ORCH_RECORD_API_URL')
  expect(
    db().query<{ count: number }, []>('SELECT count(*) count FROM board_message').get()?.count,
  ).toBe(0)
})
