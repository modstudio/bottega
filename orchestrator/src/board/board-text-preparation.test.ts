import { beforeEach, expect, test } from 'bun:test'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from '../../../shared/config-directory.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import type { HostedBoardMessage } from '../record/record-board-contract.ts'
import { hostedBoardFilingFailRefusal } from '../record/record-board-messages.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'
import { boardAccept, boardAsk, boardClaimTake, boardPost, boardReply } from './board-operations.ts'
import { postBoardSuggestion, suggestBoardPost } from './board-suggestions.ts'
import {
  abbreviateKnownCommitTokens,
  boardTextCheckout,
  prepareBoardText,
} from './board-text-preparation.ts'

const FULL_HASH = 'e2279e5d1e3d5ea24eab5369bf54943595d740f8'
const SHORT_HASH = FULL_HASH.slice(0, 12)
const FULL_HASH_64 = '4a'.repeat(32)
const noRecordEnv = {
  [CONFIG_HOME_ENV]: '/definitely-missing-config',
  [HARNESS_ENV_FILE_ENV]: '',
}
const hostedEnv = {
  CLAUDE_CODE_SESSION_ID: 'board-hash-session',
  BOTTEGA_RECORD_API_URL: 'https://record.test',
}

const hostedMessage = (id = newRecordId()): HostedBoardMessage => ({
  id,
  kind: 'notice',
  threadRootId: null,
  title: 'Hosted',
  body: 'body',
  audience: 'operator',
  origin: {
    kind: 'architect',
    session: 'board-hash-session',
    harness: 'claude',
    project: null,
    runId: null,
  },
  senderTags: [],
  createdAt: '2026-10-20T12:00:00.000Z',
  expiresAt: '2026-10-21T12:00:00.000Z',
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
  authorSession: 'board-hash-session',
  ackRequired: false,
  ackDeadline: null,
})

function runFixture(session: string) {
  return db()
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,session_id,launch_key,project_record_id)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-10-20','codex','implement','board-hash-project','sha',1,'prompt','running',?,'DEV-1954',
               (SELECT record_id FROM project WHERE name='board-hash-project'))
       RETURNING record_id AS id`,
    )
    .get(newRecordId(), session) as { id: string }
}

beforeEach(() => {
  db().query('DELETE FROM schema_meta WHERE key=?').run(BOARD_HOSTED_ADOPTED_KEY)
  db().query('DELETE FROM board_message').run()
  db().query('DELETE FROM board_claim').run()
  db()
    .query(
      `INSERT OR REPLACE INTO project(record_id,name,path,settings)
       VALUES (COALESCE((SELECT record_id FROM project WHERE name='board-hash-project'),?),'board-hash-project',?,'{}')`,
    )
    .run(newRecordId(), process.cwd())
})

test('known full commit hashes are abbreviated', () => {
  const known = (hex: string) => hex === FULL_HASH || hex === FULL_HASH_64
  expect(abbreviateKnownCommitTokens(`deployed ${FULL_HASH}`, known)).toBe(`deployed ${SHORT_HASH}`)
  expect(abbreviateKnownCommitTokens(`deployed ${FULL_HASH_64}`, known)).toBe(
    `deployed ${FULL_HASH_64.slice(0, 12)}`,
  )
})

test('an unknown full hash remains secret-shaped', () => {
  expect(abbreviateKnownCommitTokens(FULL_HASH, () => false)).toBe(FULL_HASH)
})

test('commit resolution is not consulted for abbreviated hashes', () => {
  let calls = 0
  expect(
    abbreviateKnownCommitTokens(SHORT_HASH, () => {
      calls += 1
      return true
    }),
  ).toBe(SHORT_HASH)
  expect(calls).toBe(0)
})

test('a preparation path without a known project leaves text unchanged', () => {
  let calls = 0
  expect(
    prepareBoardText(FULL_HASH, null, () => {
      calls += 1
      return true
    }),
  ).toBe(FULL_HASH)
  expect(calls).toBe(0)
})

test('checkout selection prefers the matching caller and otherwise the live target path', () => {
  expect(
    boardTextCheckout({
      callerCwd: '/worktrees/app',
      callerProject: 'app',
      targetProject: 'app',
      targetProjectPath: '/projects/app',
    }),
  ).toBe('/worktrees/app')
  expect(
    boardTextCheckout({
      callerCwd: '/worktrees/other',
      callerProject: 'other',
      targetProject: 'app',
      targetProjectPath: '/projects/app',
    }),
  ).toBe('/projects/app')
  expect(
    boardTextCheckout({
      callerCwd: '/tmp',
      callerProject: null,
      targetProject: null,
      targetProjectPath: null,
    }),
  ).toBeNull()
})

test('operation pre-send paths abbreviate a known full commit', async () => {
  const context = {
    env: noRecordEnv,
    cwd: process.cwd(),
    clock: Date.parse('2026-10-20T12:00:00Z'),
    isKnownCommit: (hex: string) => hex === FULL_HASH,
  }
  const post = await boardPost(
    {
      audience: 'operator',
      title: `Post ${FULL_HASH}`,
      body: `Body ${FULL_HASH}`,
      paths: [`src/${FULL_HASH}`],
    },
    context,
  )
  expect(
    db().query('SELECT title,body FROM board_message WHERE record_id=?').get(post.recordId),
  ).toEqual({ title: `Post ${SHORT_HASH}`, body: `Body ${SHORT_HASH}` })
  expect(
    db()
      .query("SELECT value FROM board_message_tag WHERE message_record_id=? AND kind='path'")
      .get(post.recordId),
  ).toEqual({ value: `src/${SHORT_HASH}` })

  const question = await boardAsk(
    { audience: 'operator', title: `Ask ${FULL_HASH}`, body: `Question ${FULL_HASH}` },
    { ...context, clock: context.clock + 1 },
  )
  const reply = await boardReply(question.recordId, `Reply ${FULL_HASH}`, {
    ...context,
    clock: context.clock + 2,
  })
  expect(
    db().query('SELECT body FROM board_message WHERE record_id=?').get(reply.recordId),
  ).toEqual({
    body: `Reply ${SHORT_HASH}`,
  })

  const claim = await boardClaimTake(
    {
      project: 'board-hash-project',
      subject: `resource:artifact-${FULL_HASH}`,
      note: `Claim ${FULL_HASH}`,
    },
    { ...context, clock: context.clock + 3 },
  )
  expect(claim.subject).toEqual({ kind: 'resource', value: `artifact-${SHORT_HASH}` })
  expect(claim.note).toBe(`Claim ${SHORT_HASH}`)

  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const hostedQuestion = { ...hostedMessage(), kind: 'question' as const, title: 'Question' }
  const hostedReply = {
    ...hostedMessage(),
    kind: 'reply' as const,
    threadRootId: hostedQuestion.id,
    title: null,
    body: 'answer',
  }
  const filedErrors: string[] = []
  const client = {
    ...createMemoryRecordApiClient(),
    acceptBoardAnswer: async () => ({
      root: { ...hostedQuestion, acceptedReplyId: hostedReply.id },
      replies: [hostedReply],
    }),
    takeBoardFilingLease: async () => hostedQuestion,
    failBoardFilingLease: async (_id: string, input: { error: string }) => {
      filedErrors.push(input.error)
      return { ...hostedQuestion, notePendingError: input.error }
    },
  }
  await boardAccept(hostedQuestion.id, hostedReply.id, {
    ...context,
    env: hostedEnv,
    client,
    answerNoteFiler: async () => {
      throw new Error(`Filing ${FULL_HASH}`)
    },
  })
  expect(filedErrors).toEqual([`Filing ${SHORT_HASH}`])
})

test('operation pre-send paths leave an unknown full hash for strict refusal', async () => {
  const context = {
    env: noRecordEnv,
    cwd: process.cwd(),
    clock: Date.parse('2026-10-21T12:00:00Z'),
    isKnownCommit: () => false,
  }
  await expect(
    boardPost({ audience: 'operator', title: FULL_HASH, body: 'body' }, context),
  ).rejects.toThrow(/hex-run/)
  await expect(
    boardAsk({ audience: 'operator', title: 'question', body: FULL_HASH }, context),
  ).rejects.toThrow(/hex-run/)
  const root = await boardPost({ audience: 'operator', title: 'root', body: 'body' }, context)
  await expect(boardReply(root.recordId, FULL_HASH, context)).rejects.toThrow(/hex-run/)
  await expect(
    boardClaimTake(
      { project: 'board-hash-project', subject: 'resource:safe', note: FULL_HASH },
      context,
    ),
  ).rejects.toThrow(/hex-run/)
  await expect(
    boardClaimTake({ project: 'board-hash-project', subject: `resource:${FULL_HASH}` }, context),
  ).rejects.toThrow(/hex-run/)

  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const hostedQuestion = { ...hostedMessage(), kind: 'question' as const, title: 'Question' }
  const hostedReply = {
    ...hostedMessage(),
    kind: 'reply' as const,
    threadRootId: hostedQuestion.id,
    title: null,
    body: 'answer',
  }
  const client = {
    ...createMemoryRecordApiClient(),
    acceptBoardAnswer: async () => ({
      root: { ...hostedQuestion, acceptedReplyId: hostedReply.id },
      replies: [hostedReply],
    }),
    takeBoardFilingLease: async () => hostedQuestion,
    failBoardFilingLease: async (_id: string, input: { error: string }) => {
      const refusal = hostedBoardFilingFailRefusal(input.error)
      if (refusal) throw new Error(refusal)
      return { ...hostedQuestion, notePendingError: input.error }
    },
  }
  await expect(
    boardAccept(hostedQuestion.id, hostedReply.id, {
      ...context,
      env: hostedEnv,
      client,
      answerNoteFiler: async () => {
        throw new Error(`Filing ${FULL_HASH}`)
      },
    }),
  ).rejects.toThrow(/hex-run/)
})

test('suggestion pre-send paths abbreviate a known full commit', () => {
  const clock = Date.parse('2026-10-22T12:00:00Z')
  const run = runFixture('hash-architect')
  const known = (hex: string) => hex === FULL_HASH
  const suggested = suggestBoardPost(
    run.id,
    { title: `Suggestion ${FULL_HASH}`, body: `Body ${FULL_HASH}` },
    clock,
    known,
  )
  expect(
    db().query('SELECT title,body FROM board_message WHERE record_id=?').get(suggested.recordId),
  ).toEqual({ title: `Suggestion ${SHORT_HASH}`, body: `Body ${SHORT_HASH}` })
  const posted = postBoardSuggestion(
    suggested.recordId,
    { audience: 'operator', title: `Posted ${FULL_HASH}` },
    { CLAUDE_CODE_SESSION_ID: 'hash-architect' },
    clock + 1,
    process.cwd(),
    known,
  )
  expect(
    db().query('SELECT title FROM board_message WHERE record_id=?').get(posted.recordId),
  ).toEqual({ title: `Posted ${SHORT_HASH}` })
})

test('suggestion pre-send paths leave an unknown full hash for strict refusal', () => {
  const clock = Date.parse('2026-10-23T12:00:00Z')
  const run = runFixture('unknown-hash-architect')
  expect(() =>
    suggestBoardPost(run.id, { title: FULL_HASH, body: 'body' }, clock, () => false),
  ).toThrow(/hex-run/)
  const suggested = suggestBoardPost(run.id, { title: 'Safe', body: 'body' }, clock + 1)
  expect(() =>
    postBoardSuggestion(
      suggested.recordId,
      { audience: 'operator', body: FULL_HASH },
      { CLAUDE_CODE_SESSION_ID: 'unknown-hash-architect' },
      clock + 2,
      process.cwd(),
      () => false,
    ),
  ).toThrow(/hex-run/)
})
