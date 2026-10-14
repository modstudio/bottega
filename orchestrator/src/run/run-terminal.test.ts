import { describe, expect, test } from 'bun:test'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  artifactPersistenceOutcome,
  finalizeTerminalChain,
  questionsToInsert,
  recordTerminalReviewEvidence,
  shouldCheckpointAtTerminal,
} from './run-terminal.ts'

test('a failed non-failover child closes its question before the root inherits failure', () => {
  const root = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
  const child = addRun({
    agent: 'codex',
    job: 'implement',
    status: 'failed',
    kind: 'interrupted',
    parent: root,
    turn: 2,
  })
  db()
    .query('INSERT INTO question (run_id,asked_at,question) VALUES (?,?,?)')
    .run(child, '2026-09-29', 'What should happen?')

  finalizeTerminalChain(db(), {
    runId: child,
    parentRunId: root,
    status: 'failed',
    failureKind: 'interrupted',
    error: 'worker interrupted',
  })

  expect(db().query('SELECT status,failure_kind FROM run WHERE id=?').get(root)).toEqual({
    status: 'failed',
    failure_kind: 'interrupted',
  })
  expect(db().query('SELECT close_reason FROM question WHERE run_id=?').get(child)).toEqual({
    close_reason: 'chain-terminal',
  })
})

test('artifact persistence failure retains a completed worker outcome', () => {
  expect(
    artifactPersistenceOutcome({
      status: 'ok',
      error: 'reply.json missing; used final-message fallback',
      failureKind: null,
      persistenceError: 'artifact persistence failed: named file is not a file',
    }),
  ).toEqual({
    status: 'ok',
    error:
      'reply.json missing; used final-message fallback\n' +
      'artifact persistence failed: named file is not a file',
    failureKind: null,
  })
})

describe('terminal question deduplication decision', () => {
  test('omits a question already recorded for the run', () => {
    const accepted = [{ question: 'Which table?', why: 'The migration depends on it.' }]

    expect(questionsToInsert(['Which table?'], accepted)).toEqual([])
  })

  test('treats surrounding whitespace, internal whitespace runs, and case as equivalent', () => {
    const accepted = [
      { question: '  Which table?  ', why: 'first' },
      { question: 'Which   table?', why: 'second' },
      { question: 'WHICH TABLE?', why: 'third' },
    ]

    expect(questionsToInsert([], accepted)).toEqual(accepted.slice(0, 1))
  })

  test('returns genuinely different questions in their accepted order', () => {
    const accepted = [
      { question: 'Which table?', why: 'first' },
      { question: 'Which column?', why: 'second' },
      { question: 'Which index?', why: 'third' },
    ]

    expect(questionsToInsert([], accepted)).toEqual(accepted)
  })

  test('collapses duplicates within the accepted questions', () => {
    const accepted = [
      { question: 'Which table?', why: 'first' },
      { question: 'which table?', why: 'repeated in the final reply' },
    ]

    expect(questionsToInsert([], accepted)).toEqual(accepted.slice(0, 1))
  })
})

describe('terminal checkpoint decision', () => {
  test('rejects omitting an ok writing turn from terminal checkpointing', () => {
    expect(
      shouldCheckpointAtTerminal({
        writesJob: true,
        hasWorktree: true,
        launchKey: 'DEV-623',
      }),
    ).toBe(true)
  })

  test('rejects checkpointing a read-only turn', () => {
    expect(
      shouldCheckpointAtTerminal({
        writesJob: false,
        hasWorktree: true,
        launchKey: 'DEV-623',
      }),
    ).toBe(false)
  })
})

describe('terminal review evidence', () => {
  test('a probe run with a parsed findings reply records no review, and a non-probe run still does', () => {
    const parsedReview = reviewReply(1)
    const probeRun = addRun({
      agent: 'codex',
      job: 'review-lens',
      model: 'fixture-model',
      lens: 'canon-eval',
      probe: 1,
    })
    const productRun = addRun({
      agent: 'codex',
      job: 'review-lens',
      model: 'fixture-model',
      lens: 'craft',
    })
    expect(
      recordTerminalReviewEvidence(db(), {
        runId: probeRun,
        parsedReview,
        status: 'ok',
        failureKind: null,
      }),
    ).toBeNull()
    expect(db().query('SELECT id FROM review_lens WHERE run_id=?').get(probeRun)).toBeNull()
    const reviewId = recordTerminalReviewEvidence(db(), {
      runId: productRun,
      parsedReview,
      status: 'ok',
      failureKind: null,
    })
    expect(reviewId).toBeGreaterThan(0)
    expect(db().query('SELECT review_id FROM review_lens WHERE run_id=?').get(productRun)).toEqual({
      review_id: reviewId,
    })
  })
})
