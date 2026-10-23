import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, SESSION_LIVE_MS } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import {
  boardPushDecision,
  reportReplySuccessorDecision,
  selectPushNotices,
} from './board-push-policy.ts'
import { claimPushNotices, postNotice } from './board-service.ts'
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
    successorAlreadyReceived: false,
    readerBeganAt: '2026-10-16T12:00:00.000Z',
    authorLastActivityAt: Date.parse('2026-10-16T10:00:00.000Z'),
    replyPostedAt: '2026-10-16T11:00:00.000Z',
    ...input,
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
  }
  expect(selectPushNotices('2026-10-16T12:00:00.000Z', [successor], clock, false)).toEqual({
    notices: [],
    withheldOlderCount: 0,
    deferredReplySuccessorCount: 1,
  })
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
        `SELECT reader_session,audience_at_posting,successor FROM board_receipt
         WHERE message_record_id=? AND delivered_at IS NOT NULL AND successor=1`,
      )
      .all(reply.recordId),
  ).toEqual([{ reader_session: 'later-first', audience_at_posting: 0, successor: 1 }])
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
