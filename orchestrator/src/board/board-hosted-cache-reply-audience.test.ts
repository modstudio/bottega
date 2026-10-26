import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import type { HostedBoardChange, HostedBoardMessage } from '../record/record-board-contract.ts'
import { cachedMessageAddressed, refreshHostedBoard } from './board-hosted-cache.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'

const userId = '01990000-0000-7000-8000-000000000001'

const message = (overrides: Partial<HostedBoardMessage> = {}): HostedBoardMessage => ({
  id: newRecordId(),
  kind: 'notice',
  threadRootId: null,
  title: 'Hosted cache',
  body: 'cached body',
  audience: 'session:cache-reader',
  origin: {
    kind: 'architect',
    session: 'author',
    harness: 'claude',
    project: 'cache-project',
    projectStored: true,
    runId: null,
  },
  senderTags: [],
  createdAt: '2026-10-05T12:00:00.000Z',
  expiresAt: '2027-10-05T12:00:00.000Z',
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
  authorUserId: userId,
  authorSession: 'author',
  ackRequired: false,
  ackDeadline: null,
  ...overrides,
})

const change = (value: HostedBoardMessage): HostedBoardChange => ({
  message: value,
  tags: [],
  receipts: [],
})

test('hosted reply audiences survive caching and select explicit or default participants', async () => {
  const database = db()
  database
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const root = message({
    kind: 'question',
    audience: 'session:root-audience-reader',
    authorSession: 'root-author',
  })
  const participant = message({
    kind: 'reply',
    threadRootId: root.id,
    audience: null,
    authorSession: 'thread-participant',
    createdAt: '2026-10-05T12:00:01.000Z',
  })
  const directed = message({
    kind: 'reply',
    threadRootId: root.id,
    audience: 'session:chosen-reader',
    authorSession: 'directed-replier',
    createdAt: '2026-10-05T12:00:02.000Z',
  })
  const defaulted = message({
    kind: 'reply',
    threadRootId: root.id,
    audience: null,
    authorSession: 'default-replier',
    createdAt: '2026-10-05T12:00:03.000Z',
  })
  const client = {
    ...createMemoryRecordApiClient(),
    listBoardChanges: async () => ({
      userId,
      items: [root, participant, directed, defaulted].map(change),
      highestRevision: '4',
    }),
    putBoardReceipt: async () => {
      throw new Error('unused')
    },
  }
  await refreshHostedBoard({ budgetMs: 1_000, env: { BOTTEGA_RECORD_API_URL: 'x' }, client })
  const storedDirected = JSON.parse(
    (
      database
        .query('SELECT payload FROM hosted_board_message_cache WHERE id=?')
        .get(directed.id) as { payload: string }
    ).payload,
  ) as HostedBoardMessage
  const clock = Date.parse('2026-10-05T12:02:00.000Z')

  expect(storedDirected.audience).toBe('session:chosen-reader')
  expect(cachedMessageAddressed(change(storedDirected), 'chosen-reader', clock, database)).toBe(
    true,
  )
  expect(
    cachedMessageAddressed(change(storedDirected), 'thread-participant', clock, database),
  ).toBe(false)
  expect(cachedMessageAddressed(change(defaulted), 'root-author', clock, database)).toBe(true)
  expect(cachedMessageAddressed(change(defaulted), 'thread-participant', clock, database)).toBe(
    true,
  )
  expect(cachedMessageAddressed(change(defaulted), 'chosen-reader', clock, database)).toBe(false)
})
