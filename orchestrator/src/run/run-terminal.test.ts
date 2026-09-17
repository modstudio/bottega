import { describe, expect, test } from 'bun:test'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { recordTerminalReviewEvidence, shouldCheckpointAtTerminal } from './run-terminal.ts'

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
