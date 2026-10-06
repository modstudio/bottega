import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { HostedBoardMessage, HostedBoardReceipt } from './record-board-contract.ts'
import { hostedBoardOverviewEntry } from './record-board-overview.ts'

const author = '01990000-0000-7000-8000-000000000001'
const reader = '01990000-0000-7000-8000-000000000002'

function message(kind: 'notice' | 'question'): HostedBoardMessage {
  return {
    id:
      kind === 'notice'
        ? '01990000-0000-7000-8000-000000000011'
        : '01990000-0000-7000-8000-000000000012',
    kind,
    threadRootId: null,
    title: kind === 'notice' ? 'Deploy complete' : 'Which release?',
    body: kind === 'notice' ? 'The release is live.' : 'Choose the release channel.',
    audience: `project:${PLATFORM_SLUG}`,
    origin: {
      kind: 'architect',
      session: 'session-author',
      harness: 'claude-code',
      project: null,
      runId: null,
    },
    senderTags: [{ kind: 'task', value: 'DEV-1121' }],
    createdAt: '2026-10-06T12:00:00.000Z',
    expiresAt: '2026-10-07T12:00:00.000Z',
    withdrawnAt: null,
    state: 'open',
    acceptedReplyId: null,
    acceptedBy: null,
    acceptedAt: null,
    noteId: null,
    notePendingError: null,
    revision: kind === 'notice' ? '1' : '2',
    scopeProjectIds: ['01990000-0000-7000-8000-000000000021'],
    recipientUserIds: [],
    claimId: null,
    authorUserId: author,
    authorSession: 'session-author',
    ackRequired: kind === 'notice',
    ackDeadline: kind === 'notice' ? '2026-10-06T18:00:00.000Z' : null,
  }
}

const receipts: HostedBoardReceipt[] = [
  {
    messageId: message('notice').id,
    readerUserId: reader,
    readerSession: 'session-reader-one',
    audienceAtPosting: true,
    deliveredAt: '2026-10-06T12:01:00.000Z',
    acknowledgedAt: '2026-10-06T12:02:00.000Z',
  },
  {
    messageId: message('notice').id,
    readerUserId: '01990000-0000-7000-8000-000000000003',
    readerSession: 'session-reader-two',
    audienceAtPosting: true,
    deliveredAt: '2026-10-06T12:03:00.000Z',
    acknowledgedAt: null,
  },
]

test('authored notice overview reports receipt reach and acknowledgement', () => {
  expect(hostedBoardOverviewEntry(message('notice'), 0, receipts, author)).toEqual({
    id: '01990000-0000-7000-8000-000000000011',
    kind: 'notice',
    title: 'Deploy complete',
    audience: `project:${PLATFORM_SLUG}`,
    origin: {
      kind: 'architect',
      session: 'session-author',
      harness: 'claude-code',
      project: null,
      runId: null,
    },
    senderTags: [{ kind: 'task', value: 'DEV-1121' }],
    createdAt: '2026-10-06T12:00:00.000Z',
    expiresAt: '2026-10-07T12:00:00.000Z',
    withdrawnAt: null,
    ackRequired: true,
    ackDeadline: '2026-10-06T18:00:00.000Z',
    state: 'open',
    reached: 2,
    acknowledged: 1,
    unacknowledged: ['session-reader-two'],
    store: 'hosted',
  })
})

test('question overview reports visible replies and hides another author reach', () => {
  expect(hostedBoardOverviewEntry(message('question'), 1, receipts, reader)).toEqual({
    id: '01990000-0000-7000-8000-000000000012',
    kind: 'question',
    title: 'Which release?',
    audience: `project:${PLATFORM_SLUG}`,
    origin: {
      kind: 'architect',
      session: 'session-author',
      harness: 'claude-code',
      project: null,
      runId: null,
    },
    senderTags: [{ kind: 'task', value: 'DEV-1121' }],
    createdAt: '2026-10-06T12:00:00.000Z',
    expiresAt: '2026-10-07T12:00:00.000Z',
    withdrawnAt: null,
    ackRequired: false,
    ackDeadline: null,
    state: 'open',
    reached: null,
    acknowledged: null,
    unacknowledged: null,
    store: 'hosted',
    replyCount: 1,
    acceptedReplyId: null,
  })
})
