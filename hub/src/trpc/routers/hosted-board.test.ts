import { expect, test } from 'bun:test'
import {
  BOARD_DEFAULT_ACK_DEADLINE_MS,
  BOARD_DEFAULT_EXPIRY_MS,
} from '../../../../shared/board-duration.ts'
import {
  BoardAcceptResultSchema,
  BoardListResultSchema,
  BoardPostResultSchema,
  BoardReplyResultSchema,
  BoardStatusResultSchema,
  BoardThreadResultSchema,
  BoardWithdrawResultSchema,
} from '../../board-contract.ts'
import type { RecordClient } from '../../record-client.ts'
import { createHostedBoardRouter } from './hosted-board.ts'

const rootId = '01990000-0000-7000-8000-000000000011'
const mintedPostId = '01990000-0000-7000-8000-000000000012'
const servicePostId = '01990000-0000-7000-8000-000000000013'
const mintedReplyId = '01990000-0000-7000-8000-000000000014'
const replyId = '01990000-0000-7000-8000-000000000015'
const now = Date.parse('2026-10-06T12:00:00.000Z')

const root = {
  id: rootId,
  kind: 'question',
  threadRootId: null,
  title: 'Question',
  body: 'Body',
  audience: 'architects',
  origin: { kind: 'operator', session: null, harness: null, project: null, runId: null },
  senderTags: [],
  createdAt: '2026-10-06T11:00:00.000Z',
  expiresAt: '2026-10-07T11:00:00.000Z',
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
  authorUserId: 'user-a',
  authorSession: null,
  ackRequired: false,
  ackDeadline: null,
}
const reply = {
  id: replyId,
  body: 'Answer',
  origin: root.origin,
  createdAt: '2026-10-06T11:30:00.000Z',
}
const overview = {
  id: rootId,
  kind: 'question' as const,
  title: root.title,
  audience: root.audience,
  origin: root.origin,
  senderTags: [],
  createdAt: root.createdAt,
  expiresAt: root.expiresAt,
  withdrawnAt: null,
  ackRequired: false,
  ackDeadline: null,
  state: 'open' as const,
  reached: null,
  acknowledged: null,
  unacknowledged: null,
  store: 'hosted' as const,
  replyCount: 1,
  acceptedReplyId: null,
}

test('hosted board procedures map record responses to the shared browser contract', async () => {
  const calls: Array<{ operation: string; input: unknown }> = []
  const ids = [mintedPostId, mintedReplyId, mintedPostId]
  const client = {
    boardList: async (input: unknown) => {
      calls.push({ operation: 'list', input })
      return { messages: [overview], truncated: true }
    },
    boardThread: async (id: string) => {
      calls.push({ operation: 'thread', input: id })
      return { root, replies: [reply] }
    },
    boardStatus: async (id: string) => {
      calls.push({ operation: 'status', input: id })
      return { message: root, receipts: [] }
    },
    boardPost: async (input: Parameters<RecordClient['boardPost']>[0]) => {
      calls.push({ operation: 'post', input })
      return { ...root, id: servicePostId, kind: 'notice', title: input.title }
    },
    boardReply: async (id: string, input: { id: string; body: string }) => {
      calls.push({ operation: 'reply', input: { rootId: id, ...input } })
      return { ...root, id: replyId, threadRootId: id, title: null, body: input.body }
    },
    boardAccept: async (questionId: string, acceptedReplyId: string) => {
      calls.push({ operation: 'accept', input: { questionId, acceptedReplyId } })
      return {
        root: {
          ...root,
          acceptedReplyId,
          notePendingError: 'note filing has not completed',
        },
        replies: [reply],
      }
    },
    boardWithdraw: async (id: string) => {
      calls.push({ operation: 'withdraw', input: id })
      return { ...root, id, withdrawnAt: '2026-10-06T13:00:00.000Z', state: 'withdrawn' }
    },
  }
  const caller = createHostedBoardRouter({
    clientFor: () => client,
    clock: () => now,
    newId: () => ids.shift() ?? mintedPostId,
  }).createCaller({ cookie: 'sid=abc' })

  const listed = await caller.list({ kind: 'question', open: true })
  const thread = await caller.thread({ id: rootId })
  const status = await caller.status({ id: rootId })
  const posted = await caller.post({
    audience: 'task:DEV-1121',
    project: 'workshop',
    title: 'Notice',
    body: 'Body',
    ackRequired: true,
    deadline: '10m',
    expires: '6h',
  })
  const replied = await caller.reply({ id: rootId, body: 'Answer' })
  const accepted = await caller.accept({ questionId: rootId, replyId })
  const withdrawn = await caller.withdraw({ id: rootId })

  expect(BoardListResultSchema.parse(listed).warning).toBe('Only the newest messages are listed.')
  expect(BoardThreadResultSchema.parse(thread).root.text).toBeNull()
  expect(BoardStatusResultSchema.parse(status)).toMatchObject({
    reached: null,
    acknowledged: null,
    unacknowledged: null,
  })
  expect(BoardPostResultSchema.parse(posted)).toMatchObject({ id: servicePostId, dropped: true })
  expect(BoardReplyResultSchema.parse(replied)).toMatchObject({ id: replyId, rootId })
  expect(BoardAcceptResultSchema.parse(accepted)).toMatchObject({
    accepted: replyId,
    questionId: rootId,
    notePendingError: 'note filing has not completed',
    retry: null,
  })
  expect(BoardWithdrawResultSchema.parse(withdrawn)).toEqual({ withdrawn: rootId })
  expect(calls.find((call) => call.operation === 'post')?.input).toMatchObject({
    id: mintedPostId,
    kind: 'notice',
    project: 'workshop',
    ackDeadline: new Date(now + 10 * 60_000).toISOString(),
    expiresAt: new Date(now + 6 * 3_600_000).toISOString(),
  })
  expect(calls.find((call) => call.operation === 'reply')?.input).toMatchObject({
    rootId,
    id: mintedReplyId,
    body: 'Answer',
  })
})

test('hosted board post applies the shared default durations', async () => {
  let posted: Record<string, unknown> | undefined
  const client = {
    boardList: async () => ({ messages: [], truncated: false }),
    boardThread: async () => ({ root, replies: [] }),
    boardStatus: async () => ({ message: root, receipts: [] }),
    boardPost: async (input: Record<string, unknown>) => {
      posted = input
      return { ...root, id: mintedPostId, kind: 'notice' }
    },
    boardReply: async () => ({ ...root, id: replyId, threadRootId: rootId }),
    boardAccept: async () => ({ root, replies: [] }),
    boardWithdraw: async () => root,
  }
  const caller = createHostedBoardRouter({
    clientFor: () => client,
    clock: () => now,
    newId: () => mintedPostId,
  }).createCaller({})
  await caller.post({
    audience: 'architects',
    title: 'Notice',
    body: 'Body',
    ackRequired: true,
  })
  expect(posted).toMatchObject({
    expiresAt: new Date(now + BOARD_DEFAULT_EXPIRY_MS).toISOString(),
    ackDeadline: new Date(now + BOARD_DEFAULT_ACK_DEADLINE_MS).toISOString(),
  })
})
