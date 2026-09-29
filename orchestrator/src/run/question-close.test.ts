import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import {
  closeQuestionByOperator,
  closeQuestions,
  QUESTION_CLOSE_CHAIN_TERMINAL,
  retireRunChainQuestionDeliveries,
} from './question-close.ts'

let priorSession: string | undefined

beforeEach(() => {
  priorSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = 'operator-session'
})

afterEach(() => {
  if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorSession
})

function fixture(status = 'ok'): { database: Database; questionId: number } {
  const database = new Database(':memory:')
  applyMigrations(database)
  database
    .query(
      `INSERT INTO run
       (id,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (42,'01990000-0000-7000-8000-000000000042','2026-09-29','codex','implement','sha',3,'ask',?)`,
    )
    .run(status)
  const question = database
    .query(
      `INSERT INTO question (run_id,asked_at,question)
       VALUES (42,'2026-09-29T10:01:00.000Z','Which?') RETURNING id`,
    )
    .get() as { id: number }
  return { database, questionId: question.id }
}

test('close service closes, audits and enqueues once', () => {
  const { database, questionId } = fixture()
  expect(
    closeQuestions(
      database,
      [questionId],
      QUESTION_CLOSE_CHAIN_TERMINAL,
      'architect-session',
      '2026-09-29T10:02:00.000Z',
    ),
  ).toBe(1)
  expect(closeQuestions(database, [questionId], QUESTION_CLOSE_CHAIN_TERMINAL)).toBe(0)
  expect(
    database
      .query('SELECT closed_at,close_reason,revision FROM question WHERE id=?')
      .get(questionId),
  ).toEqual({
    closed_at: '2026-09-29T10:02:00.000Z',
    close_reason: 'chain-terminal',
    revision: 2,
  })
  expect(
    database.query('SELECT action,actor_session,reason FROM question_mutation_audit').all(),
  ).toEqual([{ action: 'close', actor_session: 'architect-session', reason: 'chain-terminal' }])
  expect(database.query("SELECT kind FROM outbox WHERE kind='question'").all()).toEqual([
    { kind: 'question' },
  ])
})

test('operator close accepts a terminal question and records the supplied reason', () => {
  const { database, questionId } = fixture()
  closeQuestionByOperator(questionId, 'superseded by a later ruling', database)
  expect(database.query('SELECT close_reason FROM question WHERE id=?').get(questionId)).toEqual({
    close_reason: 'operator-closed: superseded by a later ruling',
  })
})

test('operator close refuses live, answered and blank questions', () => {
  const live = fixture('asking')
  expect(() => closeQuestionByOperator(live.questionId, 'obsolete', live.database)).toThrow(
    'chain is live; use orch answer 42',
  )
  const answered = fixture()
  answered.database
    .query("UPDATE question SET answer='yes',answered_at='2026-09-29T10:02:00.000Z' WHERE id=?")
    .run(answered.questionId)
  expect(() => closeQuestionByOperator(answered.questionId, 'obsolete', answered.database)).toThrow(
    'already answered',
  )
  expect(() => closeQuestionByOperator(answered.questionId, '   ', answered.database)).toThrow(
    '--reason must not be empty',
  )
})

test('terminal delivery retirement clears only pending state, records history and enqueues', () => {
  const { database, questionId } = fixture('stale')
  database
    .query(
      `UPDATE question SET answer='yes',answered_at='2026-09-29T10:02:00.000Z',
        answered_by='architect',delivery_pending_at='2026-09-29T10:02:00.000Z'
       WHERE id=?`,
    )
    .run(questionId)

  expect(
    retireRunChainQuestionDeliveries(
      database,
      42,
      QUESTION_CLOSE_CHAIN_TERMINAL,
      '2026-09-29T10:03:00.000Z',
    ),
  ).toBe(1)
  expect(
    database
      .query(
        'SELECT answer,answered_at,answered_by,delivery_pending_at,revision FROM question WHERE id=?',
      )
      .get(questionId),
  ).toEqual({
    answer: 'yes',
    answered_at: '2026-09-29T10:02:00.000Z',
    answered_by: 'architect',
    delivery_pending_at: null,
    revision: 2,
  })
  expect(
    database
      .query('SELECT run_id,mode,outcome,at,error FROM question_delivery WHERE question_id=?')
      .get(questionId),
  ).toEqual({
    run_id: null,
    mode: 'record-only',
    outcome: 'retired',
    at: '2026-09-29T10:03:00.000Z',
    error: 'chain-terminal',
  })
  expect(database.query("SELECT kind FROM outbox WHERE kind='question'").all()).toEqual([
    { kind: 'question' },
  ])
})

test('delivery retirement leaves an asking chain untouched', () => {
  const { database, questionId } = fixture('asking')
  database
    .query(
      `UPDATE question SET answer='yes',answered_at='2026-09-29T10:02:00.000Z',
        delivery_pending_at='2026-09-29T10:02:00.000Z' WHERE id=?`,
    )
    .run(questionId)

  expect(retireRunChainQuestionDeliveries(database, 42, QUESTION_CLOSE_CHAIN_TERMINAL)).toBe(0)
  expect(
    database.query('SELECT delivery_pending_at,revision FROM question WHERE id=?').get(questionId),
  ).toEqual({
    delivery_pending_at: '2026-09-29T10:02:00.000Z',
    revision: 1,
  })
  expect(database.query('SELECT * FROM question_delivery').all()).toEqual([])
})
