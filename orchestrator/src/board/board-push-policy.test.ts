import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, SESSION_LIVE_MS } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import {
  boardPushDecision,
  DEFERRED_REPLY_SUCCESSOR_NAMED_LIMIT,
  deferredReplySuccessorWarning,
  isWithdrawalDeliveryId,
  reportReplySuccessorDecision,
  selectPushNotices,
  WITHDRAWAL_SUPERSESSION_GRACE_MS,
  withdrawalDeliveryId,
  withdrawalDeliveryText,
  withdrawalPending,
  withdrawalSuperseded,
  withdrawalSupersessionPrefix,
} from './board-push-policy.ts'
import { claimPushNotices, markNoticesDelivered, postNotice } from './board-service.ts'
import { replyToThread } from './board-thread-service.ts'

const clock = Date.parse('2026-10-16T12:00:00.000Z')
const postedAt = '2026-10-16T11:00:00.000Z'
const postingCwd = resolve(import.meta.dir, '../../..')

const decision = (input: Partial<Parameters<typeof boardPushDecision>[0]> = {}) =>
  boardPushDecision({
    acknowledgementRequired: true,
    postedAt,
    acknowledgementDeadline: '2026-10-16T13:00:00.000Z',
    expiresAt: '2026-10-17T12:00:00.000Z',
    purpose: 'request',
    readerBeganAt: '2026-10-16T10:00:00.000Z',
    clock,
    ...input,
  })

const successorDecision = (
  input: Partial<Parameters<typeof reportReplySuccessorDecision>[0]> = {},
) =>
  reportReplySuccessorDecision({
    rootAuthorLive: false,
    rootAuthorReceivedReply: false,
    readerIsArchitect: true,
    readerProject: 'project',
    rootProject: 'project',
    readerIsParticipant: false,
    successorClaimed: false,
    readerBeganAt: '2026-10-16T12:00:00.000Z',
    authorLastActivityAt: Date.parse('2026-10-16T10:00:00.000Z'),
    replyPostedAt: '2026-10-16T11:00:00.000Z',
    ...input,
  })

const pendingWithdrawal = (input: Partial<Parameters<typeof withdrawalPending>[0]> = {}) =>
  withdrawalPending({
    isRoot: true,
    withdrawnReason: 'author',
    withdrawnAt: '2026-10-16T12:00:00.000Z',
    deliveredAt: '2026-10-16T11:00:00.000Z',
    authorSession: 'author',
    readerSession: 'reader',
    alreadyDelivered: false,
    now: Date.parse('2026-10-16T12:00:00.000Z') + WITHDRAWAL_SUPERSESSION_GRACE_MS,
    ...input,
  })

test('a withdrawal is pending only after an earlier delivery to another session', () => {
  expect(pendingWithdrawal()).toBe(true)
  expect(
    pendingWithdrawal({
      now: Date.parse('2026-10-16T12:00:00.000Z') + WITHDRAWAL_SUPERSESSION_GRACE_MS - 1,
    }),
  ).toBe(false)
  expect(pendingWithdrawal({ isRoot: false })).toBe(false)
  expect(pendingWithdrawal({ withdrawnReason: null })).toBe(false)
  expect(pendingWithdrawal({ withdrawnReason: 'adopted' })).toBe(false)
  expect(pendingWithdrawal({ withdrawnReason: 'suggestion-promoted' })).toBe(false)
  expect(pendingWithdrawal({ withdrawnReason: 'suggestion-declined' })).toBe(false)
  expect(pendingWithdrawal({ deliveredAt: null })).toBe(false)
  expect(pendingWithdrawal({ authorSession: 'reader' })).toBe(false)
  expect(pendingWithdrawal({ alreadyDelivered: true })).toBe(false)
  expect(pendingWithdrawal({ deliveredAt: '2026-10-16T12:00:00.001Z' })).toBe(false)
})

test('withdrawal delivery owns its id and text format', () => {
  expect(withdrawalDeliveryId('7')).toBe('withdrawn:7')
  expect(isWithdrawalDeliveryId('withdrawn:7')).toBe(true)
  expect(isWithdrawalDeliveryId('7')).toBe(false)
  expect(
    withdrawalDeliveryText({
      id: '7',
      title: 'Notice',
      withdrawnAt: '2026-10-16T12:00:00.000Z',
    }),
  ).toBe(
    'WITHDRAWN: "Notice" (7) was withdrawn by its author at 2026-10-16T12:00:00.000Z; anything you paused for it may resume.',
  )
})

test('a later root with the same author and title prefix supersedes a withdrawal', () => {
  const withdrawn = {
    authorSession: 'author',
    title: 'Load gate: HOLD',
    createdAt: '2026-10-16T11:00:00.000Z',
  }
  const root = (input: Partial<typeof withdrawn & { withdrawnAt: string | null }> = {}) => ({
    ...withdrawn,
    createdAt: '2026-10-16T12:00:00.000Z',
    ...input,
  })

  expect(withdrawalSupersessionPrefix(' Load gate : HOLD')).toBe('Load gate')
  expect(withdrawalSupersessionPrefix('Load gate')).toBeNull()
  expect(withdrawalSuperseded(withdrawn, [root()])).toBe(true)
  expect(withdrawalSuperseded(withdrawn, [root({ authorSession: 'other' })])).toBe(false)
  expect(withdrawalSuperseded(withdrawn, [root({ title: 'Machine gate: HOLD' })])).toBe(false)
  expect(withdrawalSuperseded(withdrawn, [root({ createdAt: '2026-10-16T10:00:00.000Z' })])).toBe(
    false,
  )
  expect(withdrawalSuperseded({ ...withdrawn, title: 'Load gate' }, [root()])).toBe(false)
})

test('a report reply successor is withheld when the reporter received the reply', () => {
  expect(successorDecision({ rootAuthorReceivedReply: true })).toBe(false)
})

test('a report reply successor is withheld when the reply predates reporter activity', () => {
  expect(successorDecision({ replyPostedAt: '2026-10-16T09:00:00.000Z' })).toBe(false)
})

test('acknowledgement delivery ends at its deadline and belongs only to sessions already running', () => {
  expect(decision({ acknowledgementDeadline: '2026-10-16T11:59:59.999Z' })).toBe('withheld')
  expect(
    decision({
      acknowledgementDeadline: '2026-10-16T11:59:59.999Z',
      readerBeganAt: '2026-10-16T11:00:00.001Z',
    }),
  ).toBe('withheld')
  expect(decision()).toBe('acknowledgement')
  expect(decision({ readerBeganAt: null })).toBe('withheld')
  expect(decision({ readerBeganAt: 'unbounded' })).toBe('acknowledgement')
  expect(decision({ purpose: 'standing', readerBeganAt: '2026-10-16T11:00:00.001Z' })).toBe(
    'withheld',
  )
  expect(
    decision({
      acknowledgementRequired: false,
      acknowledgementDeadline: null,
      purpose: 'standing',
      readerBeganAt: '2026-10-16T11:00:00.001Z',
    }),
  ).toBe('ordinary')
})

test('an open unexpired request is delivered to a session that began before the post', () => {
  expect(
    decision({
      acknowledgementRequired: false,
      acknowledgementDeadline: null,
      purpose: 'request',
      readerBeganAt: '2026-10-16T10:00:00.000Z',
    }),
  ).toBe('ordinary')
})

test('a session that began after a post is not pushed an older request', () => {
  const later = '2026-10-16T11:00:00.001Z'
  expect(
    decision({
      acknowledgementRequired: false,
      acknowledgementDeadline: null,
      purpose: 'request',
      readerBeganAt: later,
    }),
  ).toBe('withheld')
  expect(
    decision({
      acknowledgementRequired: false,
      acknowledgementDeadline: null,
      purpose: 'information',
      readerBeganAt: later,
    }),
  ).toBe('withheld')
  expect(
    decision({
      acknowledgementRequired: false,
      acknowledgementDeadline: null,
      purpose: 'standing',
      readerBeganAt: later,
    }),
  ).toBe('ordinary')
  expect(decision({ readerBeganAt: later })).toBe('withheld')
  expect(
    decision({
      acknowledgementRequired: false,
      acknowledgementDeadline: null,
      purpose: 'information',
      readerBeganAt: later,
      reportReplySuccessor: true,
    }),
  ).toBe('ordinary')
})

test('a read-only delivery defers a reply successor instead of claiming it', () => {
  const successor = {
    ackRequired: false,
    ackDeadline: null,
    createdAt: postedAt,
    expiresAt: null,
    reportReplySuccessor: true,
    threadTitle: 'Report thread',
  }
  expect(selectPushNotices('2026-10-16T12:00:00.000Z', [successor], clock, false)).toEqual({
    notices: [],
    withheldOlderCount: 0,
    deferredReplySuccessorCount: 1,
    deferredReplySuccessors: [successor],
  })
})

test('a read-only delivery does not defer an expired reply successor', () => {
  const successor = {
    ackRequired: false,
    ackDeadline: null,
    createdAt: postedAt,
    expiresAt: '2026-10-16T11:59:59.999Z',
    reportReplySuccessor: true,
    threadTitle: 'Expired report thread',
  }
  expect(selectPushNotices('2026-10-16T12:00:00.000Z', [successor], clock, false)).toEqual({
    notices: [],
    withheldOlderCount: 1,
    deferredReplySuccessorCount: 0,
    deferredReplySuccessors: [],
  })
})

test('deferred reply warning names two held replies and the writable delivery command', () => {
  expect(
    deferredReplySuccessorWarning(
      [
        { threadTitle: 'First report', replyRecordId: 'reply-1' },
        { threadTitle: 'Second report', replyRecordId: 'reply-2' },
      ],
      `${PLATFORM_SLUG} board pending --session successor-session`,
    ),
  ).toBe(
    `Deferred report replies: "First report" (reply reply-1), "Second report" (reply reply-2). Each is held, not lost. The next board delivery that can claim it delivers it. Run ${PLATFORM_SLUG} board pending --session successor-session to deliver it now.`,
  )
})

test('deferred reply warning bounds named replies and counts the remainder', () => {
  const replies = Array.from({ length: DEFERRED_REPLY_SUCCESSOR_NAMED_LIMIT + 2 }, (_, index) => ({
    threadTitle: `Report ${index + 1}`,
    replyRecordId: `reply-${index + 1}`,
  }))
  const warning = deferredReplySuccessorWarning(
    replies,
    `${PLATFORM_SLUG} board pending --session successor-session`,
  )
  expect(warning).toContain(`"Report ${DEFERRED_REPLY_SUCCESSOR_NAMED_LIMIT}"`)
  expect(warning).not.toContain(`"Report ${DEFERRED_REPLY_SUCCESSOR_NAMED_LIMIT + 1}"`)
  expect(warning).toContain('and 2 more')
})

test('deferred reply warning is absent when no replies were deferred', () => {
  expect(
    deferredReplySuccessorWarning([], `${PLATFORM_SLUG} board pending --session successor-session`),
  ).toBeNull()
})

function ensurePostingProject() {
  db()
    .query(
      `INSERT OR IGNORE INTO project(record_id,name,path,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'push-policy-project',?,'{}')`,
    )
    .run(postingCwd)
  const project = projectAt(postingCwd)
  if (!project) throw new Error('push-policy test posting project did not resolve')
  return project
}

function insertArchitect(session: string, project: string, firstSeen: number, lastSeen: number) {
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect','test',?,(SELECT record_id FROM project WHERE name=?),?,NULL,?,?)`,
    )
    .run(
      session,
      project,
      project,
      postingCwd,
      new Date(firstSeen).toISOString(),
      new Date(lastSeen).toISOString(),
    )
}

test('a report reply reaches the first later architect session of the posting project', () => {
  const project = ensurePostingProject().name
  const postedAtMs = clock - SESSION_LIVE_MS - 60_000
  const replyAt = postedAtMs + 30_000
  insertArchitect('report-author', project, postedAtMs - 1_000, postedAtMs)
  const posted = postNotice(
    {
      audience: 'session:report-author',
      title: 'Report',
      body: 'The work is blocked.',
      purpose: 'request',
    },
    { CLAUDE_CODE_SESSION_ID: 'report-author' },
    postedAtMs,
    postingCwd,
  )
  db()
    .query('UPDATE presence SET last_seen=? WHERE session_id=?')
    .run(new Date(postedAtMs).toISOString(), 'report-author')
  const reply = replyToThread(posted.recordId, 'The ruling is in.', {}, replyAt, postingCwd)
  insertArchitect('later-first', project, replyAt + 1_000, clock)
  insertArchitect('later-second', project, replyAt + 2_000, clock)
  const first = claimPushNotices(false, { CLAUDE_CODE_SESSION_ID: 'later-first' }, clock)
  expect(first.notices.map((notice) => notice.recordId)).toEqual([reply.recordId])
  const second = claimPushNotices(false, { CLAUDE_CODE_SESSION_ID: 'later-second' }, clock)
  expect(second.notices.map((notice) => notice.recordId)).toEqual([])
  expect(
    db()
      .query(
        `SELECT reader_session,audience_at_posting,successor,delivered_at FROM board_receipt
         WHERE message_record_id=? AND successor=1`,
      )
      .all(reply.recordId),
  ).toEqual([
    { reader_session: 'later-first', audience_at_posting: 0, successor: 1, delivered_at: null },
  ])
})

test('a session which began before the reply does not receive it as the successor', () => {
  const project = ensurePostingProject().name
  const postedAtMs = clock - SESSION_LIVE_MS - 60_000
  const replyAt = postedAtMs + 30_000
  insertArchitect('early-author', project, postedAtMs - 2_000, postedAtMs)
  insertArchitect('already-running', project, postedAtMs - 1_000, clock)
  const posted = postNotice(
    {
      audience: 'session:early-author',
      title: 'Report',
      body: 'The work is blocked.',
      purpose: 'request',
    },
    { CLAUDE_CODE_SESSION_ID: 'early-author' },
    postedAtMs,
    postingCwd,
  )
  db()
    .query('UPDATE presence SET last_seen=? WHERE session_id=?')
    .run(new Date(postedAtMs).toISOString(), 'early-author')
  const reply = replyToThread(posted.recordId, 'The ruling is in.', {}, replyAt, postingCwd)
  const pending = claimPushNotices(false, { CLAUDE_CODE_SESSION_ID: 'already-running' }, clock)
  expect(pending.notices.map((notice) => notice.recordId)).not.toContain(reply.recordId)
})

test('an ordinary non-audience delivery does not block the report reply successor', () => {
  const project = ensurePostingProject().name
  const postedAtMs = clock - SESSION_LIVE_MS - 60_000
  const replyAt = postedAtMs + 30_000
  insertArchitect('ordinary-author', project, postedAtMs - 1_000, postedAtMs)
  const posted = postNotice(
    {
      audience: 'session:ordinary-author',
      title: 'Report',
      body: 'The work is blocked.',
      purpose: 'request',
    },
    { CLAUDE_CODE_SESSION_ID: 'ordinary-author' },
    postedAtMs,
    postingCwd,
  )
  db()
    .query('UPDATE presence SET last_seen=? WHERE session_id=?')
    .run(new Date(postedAtMs).toISOString(), 'ordinary-author')
  const reply = replyToThread(posted.recordId, 'The ruling is in.', {}, replyAt, postingCwd)
  db()
    .query(
      `INSERT INTO board_receipt
       (message_record_id,reader_session,audience_at_posting,delivered_at,record_id)
       VALUES (?,?,0,?,?)`,
    )
    .run(reply.recordId, 'late-ordinary-reader', new Date(clock).toISOString(), newRecordId())
  insertArchitect('ordinary-later', project, replyAt + 1_000, clock)
  const first = claimPushNotices(false, { CLAUDE_CODE_SESSION_ID: 'ordinary-later' }, clock)
  expect(first.notices.map((notice) => notice.recordId)).toEqual([reply.recordId])
  expect(
    db()
      .query(
        `SELECT reader_session,successor FROM board_receipt
         WHERE message_record_id=? AND successor=1`,
      )
      .all(reply.recordId),
  ).toEqual([{ reader_session: 'ordinary-later', successor: 1 }])
})

function successorThreadFixture(label: string) {
  const project = ensurePostingProject().name
  const postedAtMs = clock - SESSION_LIVE_MS - 60_000
  const replyAt = postedAtMs + 30_000
  insertArchitect(`${label}-author`, project, postedAtMs - 1_000, postedAtMs)
  const posted = postNotice(
    {
      audience: `session:${label}-author`,
      title: `${label} report`,
      body: 'The work is blocked.',
      purpose: 'request',
    },
    { CLAUDE_CODE_SESSION_ID: `${label}-author` },
    postedAtMs,
    postingCwd,
  )
  db()
    .query('UPDATE presence SET last_seen=? WHERE session_id=?')
    .run(new Date(postedAtMs).toISOString(), `${label}-author`)
  const reply = replyToThread(posted.recordId, 'The ruling is in.', {}, replyAt, postingCwd)
  insertArchitect(`${label}-later`, project, replyAt + 1_000, clock)
  return { replyId: reply.recordId, reader: `${label}-later` }
}

function successorReceipt(replyId: string, reader: string) {
  return db()
    .query(
      'SELECT successor,delivered_at FROM board_receipt WHERE message_record_id=? AND reader_session=?',
    )
    .get(replyId, reader) as { successor: number; delivered_at: string | null }
}

test('a claimant who began after the reply is re-offered until acknowledged', () => {
  const { replyId, reader } = successorThreadFixture('reoffer-ack')
  const env = { CLAUDE_CODE_SESSION_ID: reader }
  expect(claimPushNotices(false, env, clock).notices.map((notice) => notice.recordId)).toEqual([
    replyId,
  ])
  expect(successorReceipt(replyId, reader)).toEqual({ successor: 1, delivered_at: null })
  expect(claimPushNotices(false, env, clock + 1).notices.map((notice) => notice.recordId)).toEqual([
    replyId,
  ])
  expect(successorReceipt(replyId, reader)).toEqual({ successor: 1, delivered_at: null })
  markNoticesDelivered([replyId], env, clock + 2)
  const stamped = successorReceipt(replyId, reader)
  expect(stamped.successor).toBe(1)
  expect(stamped.delivered_at).not.toBeNull()
  expect(claimPushNotices(false, env, clock + 3).notices).toEqual([])
})
