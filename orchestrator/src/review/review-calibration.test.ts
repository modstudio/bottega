import { describe, expect, test } from 'bun:test'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { addRun, score } from '../../test/fixtures/store.ts'
import { db } from '../db.ts'
import { state } from '../serve.ts'
import { calibrationLine, reviewCalibration, reviewCalibrationFleet } from './review-calibration.ts'
import {
  completeReview,
  gradeReviewLens,
  MIN_REVIEW_TRIAGED,
  recordReview,
  triageFinding,
} from './review-triage.ts'

describe('review discipline', () => {
  test('fleet calibration groups graded models and emits null-model empty record pairs', () => {
    const graded = addRun({ agent: 'codex', job: 'review-lens', model: 'm1', lens: 'fleet-a' })
    const gradedReview = recordReview(graded, reviewReply(MIN_REVIEW_TRIAGED), db())
    gradeReviewLens(graded, null, {
      reproduced: 'all',
      coverage: 'adequate',
      limits: 'named',
      overlap: 'alone',
    })
    for (let i = 1; i <= MIN_REVIEW_TRIAGED; i++) triageFinding(gradedReview, i, 'accepted')
    completeReview(gradedReview)
    db()
      .query("INSERT INTO score (run_id,delivery,quality,scored_at) VALUES (?,'full','right',?)")
      .run(graded, '2026-02-03T00:00:00.000Z')
    const ungraded = addRun({ agent: 'grok', job: 'review-lens', model: 'm2', lens: 'fleet-b' })
    const ungradedReview = recordReview(ungraded, reviewReply(0), db())
    completeReview(ungradedReview)
    for (const model of ['m3', 'm4']) {
      const runId = addRun({ agent: 'codex', job: 'review-lens', model, lens: 'fleet-c' })
      const reviewId = recordReview(runId, reviewReply(MIN_REVIEW_TRIAGED / 2), db())
      gradeReviewLens(runId, null, {
        reproduced: 'all',
        coverage: 'adequate',
        limits: 'named',
        overlap: 'alone',
      })
      for (let i = 1; i <= MIN_REVIEW_TRIAGED / 2; i++) triageFinding(reviewId, i, 'accepted')
      completeReview(reviewId)
      db()
        .query("INSERT INTO score (run_id,delivery,quality,scored_at) VALUES (?,'full','right',?)")
        .run(runId, model === 'm3' ? '2026-02-04T00:00:00.000Z' : '2026-02-05T00:00:00.000Z')
    }
    const legacy = addRun({
      agent: 'legacy',
      job: 'review-lens',
      model: 'legacy-model',
      lens: 'fleet-d',
    })
    const legacyReview = recordReview(legacy, reviewReply(MIN_REVIEW_TRIAGED), db())
    db().query('UPDATE review_lens SET model=NULL WHERE run_id=?').run(legacy)
    gradeReviewLens(legacy, null, {
      reproduced: 'all',
      coverage: 'adequate',
      limits: 'named',
      overlap: 'alone',
    })
    for (let i = 1; i <= MIN_REVIEW_TRIAGED; i++) triageFinding(legacyReview, i, 'accepted')
    completeReview(legacyReview)
    db()
      .query("INSERT INTO score (run_id,delivery,quality,scored_at) VALUES (?,'full','right',?)")
      .run(legacy, '2026-02-06T00:00:00.000Z')

    expect(reviewCalibrationFleet()).toEqual([
      {
        lens: 'fleet-a',
        agent: 'codex',
        model: 'm1',
        n: MIN_REVIEW_TRIAGED,
        precision: 1,
        basis: 'model',
        last_graded_at: '2026-02-03T00:00:00.000Z',
      },
      {
        lens: 'fleet-a',
        agent: 'grok',
        model: null,
        n: 0,
        precision: null,
        basis: null,
        last_graded_at: null,
      },
      {
        lens: 'fleet-a',
        agent: 'legacy',
        model: null,
        n: 0,
        precision: null,
        basis: null,
        last_graded_at: null,
      },
      {
        lens: 'fleet-b',
        agent: 'codex',
        model: null,
        n: 0,
        precision: null,
        basis: null,
        last_graded_at: null,
      },
      {
        lens: 'fleet-b',
        agent: 'grok',
        model: null,
        n: 0,
        precision: null,
        basis: null,
        last_graded_at: null,
      },
      {
        lens: 'fleet-b',
        agent: 'legacy',
        model: null,
        n: 0,
        precision: null,
        basis: null,
        last_graded_at: null,
      },
      {
        lens: 'fleet-c',
        agent: 'codex',
        model: 'm3',
        n: MIN_REVIEW_TRIAGED / 2,
        precision: null,
        basis: 'model',
        last_graded_at: '2026-02-04T00:00:00.000Z',
      },
      {
        lens: 'fleet-c',
        agent: 'codex',
        model: 'm4',
        n: MIN_REVIEW_TRIAGED / 2,
        precision: null,
        basis: 'model',
        last_graded_at: '2026-02-05T00:00:00.000Z',
      },
      {
        lens: 'fleet-c',
        agent: 'codex',
        model: null,
        n: MIN_REVIEW_TRIAGED,
        precision: 1,
        basis: 'aggregate',
        last_graded_at: '2026-02-05T00:00:00.000Z',
      },
      {
        lens: 'fleet-c',
        agent: 'grok',
        model: null,
        n: 0,
        precision: null,
        basis: null,
        last_graded_at: null,
      },
      {
        lens: 'fleet-c',
        agent: 'legacy',
        model: null,
        n: 0,
        precision: null,
        basis: null,
        last_graded_at: null,
      },
      {
        lens: 'fleet-d',
        agent: 'codex',
        model: null,
        n: 0,
        precision: null,
        basis: null,
        last_graded_at: null,
      },
      {
        lens: 'fleet-d',
        agent: 'grok',
        model: null,
        n: 0,
        precision: null,
        basis: null,
        last_graded_at: null,
      },
      {
        lens: 'fleet-d',
        agent: 'legacy',
        model: null,
        n: MIN_REVIEW_TRIAGED,
        precision: 1,
        basis: 'aggregate',
        last_graded_at: '2026-02-06T00:00:00.000Z',
      },
    ])
  })
  test('a completed review scored full right --void is not reviewer-precision evidence', () => {
    const make = (voided: boolean) => {
      const runId = addRun({
        agent: 'codex',
        job: 'review-lens',
        model: 'void-cal',
        lens: 'void-cal',
      })
      const reviewId = recordReview(runId, reviewReply(1), db())
      triageFinding(reviewId, 1, 'accepted')
      completeReview(reviewId)
      score(runId, 'full', 'right')
      if (voided) {
        db()
          .query("UPDATE run SET evidence_excluded='voided with orch score --void' WHERE id=?")
          .run(runId)
      }
      return runId
    }
    make(false)
    make(true)
    expect(reviewCalibration('void-cal', 'codex', 'void-cal')).toMatchObject({
      hits: 1,
      triaged: 1,
    })
  })
  test('precision counts accepted and modified as hits, rejects as misses, and skips nothing', () => {
    const make = (
      model: string,
      disposition: 'accepted' | 'modified' | 'rejected' | 'skipped',
      n: number,
    ) => {
      const runId = addRun({ agent: 'codex', job: 'review-lens', model, lens: 'correctness' })
      const reviewId = recordReview(runId, reviewReply(n), db())
      for (let i = 1; i <= n; i++)
        triageFinding(
          reviewId,
          i,
          disposition,
          disposition === 'rejected' ? 'not-a-defect' : undefined,
        )
      completeReview(reviewId)
    }
    make('old', 'accepted', 4)
    make('old', 'modified', 3)
    make('old', 'rejected', 3)
    make('old', 'skipped', 8)
    let c = reviewCalibration('correctness', 'codex', 'current')
    expect(c).toMatchObject({ precision: 0.7, hits: 7, triaged: 10, basis: 'agent' })
    expect(c.rejection_categories).toEqual([{ category: 'not-a-defect', count: 3 }])
    expect(c.tiers.unclassified).toEqual({
      reviews: 4,
      lenses: 4,
      findings_accepted: 4,
      findings_rejected: 3,
      rounds: { min: 1, median: 1, max: 1 },
    })

    make('current', 'accepted', MIN_REVIEW_TRIAGED - 1)
    c = reviewCalibration('correctness', 'codex', 'current')
    expect(c.basis).toBe('agent')
    make('current', 'rejected', 1)
    c = reviewCalibration('correctness', 'codex', 'current')
    expect(c).toMatchObject({ precision: 0.9, hits: 9, triaged: 10, basis: 'model' })
  })
  test('below-floor and untriaged evidence report null, never zero', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'efficiency' })
    const reviewId = recordReview(runId, reviewReply(1), db())
    triageFinding(reviewId, 1, 'rejected', 'false-positive')
    expect(reviewCalibration('efficiency', 'codex', 'm').precision).toBeNull()
    completeReview(reviewId)
    const c = reviewCalibration('efficiency', 'codex', 'm')
    expect(c.precision).toBeNull()
    expect(calibrationLine(c)).toContain('no reliable precision yet')
  })
  test('derives MIRROR review recording and calibration from the lens run without changing review_lens schema', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'mirror-mode' })
    db()
      .query(
        `UPDATE run SET mcp=1, mcp_server='fixture-project', mcp_connected=0,
                      mcp_error='mirror: attachment failed' WHERE id=?`,
      )
      .run(runId)
    const reviewId = recordReview(runId, reviewReply(0), db())
    completeReview(reviewId)
    const calibration = reviewCalibration('mirror-mode', 'codex', 'm')
    expect(calibration.mirror_lenses).toBe(1)
    expect(calibrationLine(calibration)).toContain('MIRROR lenses: 1')

    const ddl = (
      db()
        .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='review_lens'")
        .get() as { sql: string }
    ).sql
    expect(ddl).not.toContain('mcp_mode')
    expect(ddl).not.toContain('provenance')

    const cliRun = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'mirror-mode' })
    db()
      .query(`UPDATE run SET mcp=1, mcp_server='fixture-project', mcp_connected=0,
                      mcp_error='mirror: attachment failed' WHERE id=?`)
      .run(cliRun)
    const recorded = recordReview(cliRun, reviewReply(0), db())
    expect(db().query('SELECT review_id FROM review_lens WHERE run_id=?').get(cliRun)).toEqual({
      review_id: recorded,
    })
  })
  test('per-tier calibration counts lens rounds per branch', () => {
    for (const [branch, rounds] of [
      ['one-round', 1],
      ['three-rounds', 3],
    ] as const) {
      for (let round = 0; round < rounds; round++) {
        const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'rounds' })
        db()
          .query('UPDATE run SET branch=?, launch_key=? WHERE id=?')
          .run(`${branch}-worker-${round}`, branch, runId)
        const reviewId = recordReview(runId, reviewReply(0), db())
        db()
          .query(
            "UPDATE review SET tier=2, tier_risk=2, tier_size=0, tier_reason='risk 2: fixture' WHERE id=?",
          )
          .run(reviewId)
        completeReview(reviewId)
      }
    }
    const tiers = reviewCalibration('rounds', 'codex', 'm').tiers
    expect(tiers['2'].rounds).toEqual({ min: 1, median: 2, max: 3 })
    expect(tiers['0'].rounds).toEqual({ min: null, median: null, max: null })
  })
  test('calibration and state count graded values and preserve historical null grades', () => {
    const gradedRun = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'graded' })
    const gradedReview = recordReview(gradedRun, reviewReply(MIN_REVIEW_TRIAGED), db())
    gradeReviewLens(gradedRun, null, {
      reproduced: 'all',
      coverage: 'adequate',
      limits: 'named',
      overlap: 'alone',
    })
    for (let i = 1; i <= MIN_REVIEW_TRIAGED; i++) triageFinding(gradedReview, i, 'accepted')
    completeReview(gradedReview)

    const historicalRun = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'graded' })
    const historicalReview = recordReview(historicalRun, reviewReply(1), db())
    triageFinding(historicalReview, 1, 'accepted')
    completeReview(historicalReview)

    const c = reviewCalibration('graded', 'codex', 'm')
    expect(c.reproduced).toEqual({
      counts: { none: 0, some: 0, all: 1 },
      shares: { none: 0, some: 0, all: 1 },
      ungraded: 1,
    })
    expect(c.overlap).toEqual({
      counts: { unique: 0, shared: 0, none: 0, alone: 1 },
      shares: { unique: 0, shared: 0, none: 0, alone: 1 },
      ungraded: 1,
    })
    expect(c.severity).toEqual({
      counts: { agreed: 0, changed: 0, not_comparable: 0, not_assessed: MIN_REVIEW_TRIAGED + 1 },
      shares: { agreed: 0, changed: 0, not_comparable: 0, not_assessed: 1 },
    })
    const cells = state(null).reviewCalibration as (typeof c)[]
    expect(cells.find((cell) => cell.lens === 'graded' && cell.model === 'm')).toMatchObject({
      reproduced: c.reproduced,
      overlap: c.overlap,
    })
  })
  test('grade shares use graded rows independently of the finding precision floor', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'clean-grade' })
    const reviewId = recordReview(runId, reviewReply(0), db())
    gradeReviewLens(runId, null, {
      reproduced: 'none',
      coverage: 'adequate',
      limits: 'absent',
      overlap: 'none',
    })
    completeReview(reviewId)
    const c = reviewCalibration('clean-grade', 'codex', 'm')
    expect(c.precision).toBeNull()
    expect(c.coverage).toEqual({
      counts: { empty: 0, partial: 0, adequate: 1 },
      shares: { empty: 0, partial: 0, adequate: 1 },
      ungraded: 0,
    })
  })
  test('severity calibration separates agreement, changes, and off-scale lens claims', () => {
    const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'severity-cell' })
    const reviewId = recordReview(runId, reviewReply(3, 'high'), db())
    db()
      .query("UPDATE review_finding SET severity='major' WHERE review_id=? AND ordinal=3")
      .run(reviewId)
    triageFinding(reviewId, 1, 'accepted', undefined, 'high')
    triageFinding(reviewId, 2, 'accepted', undefined, 'critical')
    triageFinding(reviewId, 3, 'accepted', undefined, 'low')
    completeReview(reviewId)
    expect(reviewCalibration('severity-cell', 'codex', 'm').severity).toEqual({
      counts: { agreed: 1, changed: 1, not_comparable: 1, not_assessed: 0 },
      shares: { agreed: 1 / 3, changed: 1 / 3, not_comparable: 1 / 3, not_assessed: 0 },
    })
  })
  test('uses only the most recent fifty complete reviews', () => {
    const add = (disposition: 'accepted' | 'rejected') => {
      const runId = addRun({ agent: 'codex', job: 'review-lens', model: 'm', lens: 'window' })
      const reviewId = recordReview(runId, reviewReply(1), db())
      triageFinding(
        reviewId,
        1,
        disposition,
        disposition === 'rejected' ? 'false-positive' : undefined,
      )
      completeReview(reviewId)
    }
    add('accepted')
    for (let i = 0; i < 50; i++) add('rejected')
    expect(reviewCalibration('window', 'codex', 'm')).toMatchObject({
      precision: 0,
      hits: 0,
      triaged: 50,
      basis: 'model',
    })
  })
})
