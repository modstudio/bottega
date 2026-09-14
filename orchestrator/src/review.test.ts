import { describe, expect, test } from 'bun:test'
import { reviewReply } from '../test/fixtures/replies.ts'
import { addRun } from '../test/fixtures/store.ts'
import { db } from './db.ts'
import { recordReview } from './review.ts'
import { triageFinding } from './review.ts'

describe('review triage', () => {
  test('review triage --severity stores explicit agreement and omission stores null', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'triage' }); const reviewId = recordReview(runId, reviewReply(2, 'high'), db())
    triageFinding(reviewId, 1, 'accepted', undefined, 'high', db()); triageFinding(reviewId, 2, 'accepted', undefined, undefined, db())
    expect(db().query('SELECT ordinal,triaged_severity FROM review_finding WHERE review_id=? ORDER BY ordinal').all(reviewId)).toEqual([{ ordinal: 1, triaged_severity: 'high' }, { ordinal: 2, triaged_severity: null }])
    expect(() => triageFinding(reviewId, 2, 'accepted', undefined, 'banana', db())).toThrow('critical | high | medium | low')
  })

  test('duplicate triage severity is refused without changing the finding', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'triage-duplicate' }); const reviewId = recordReview(runId, reviewReply(1), db())
    expect(() => triageFinding(reviewId, 1, 'accepted', undefined, 'banana', db())).toThrow('severity must be')
    expect(db().query('SELECT disposition,triaged_severity,triaged_at FROM review_finding WHERE review_id=?').get(reviewId)).toEqual({ disposition: null, triaged_severity: null, triaged_at: null })
  })
})
