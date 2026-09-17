import { describe, expect, test } from 'bun:test'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { addRun, score } from '../../test/fixtures/store.ts'
import { db, nowIso } from '../database/db.ts'
import {
  completeReview,
  MIN_REVIEW_TRIAGED,
  recordReview,
  triageFinding,
} from '../review/review-triage.ts'
import {
  BETA_SCALE,
  candidates,
  currentPolicySelection,
  EVIDENCE_WINDOW,
  MIN_SAMPLE,
  NOISE_BAND,
  POSTERIOR_NOISE_BAND,
  pick,
  STANDING_EXPLORE_RATE,
  standingExploreRate,
} from './route.ts'

describe('routing exploration', () => {
  test('an unproven agent can still win the exploration coin with Thompson proven ranking', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
    }
    const random = Math.random
    Math.random = () => 0
    try {
      const routed = pick('review-lens')
      expect(routed.agent).toBe('grok')
      expect(routed.reason).toContain('thompson; challenger')
    } finally {
      Math.random = random
    }
  })

  test('draw=false ranks proven agents by the same shrunk posterior mean', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'full', 'wrong')
    }
    const expected = candidates('review-lens')
      .filter((candidate) => candidate.evidence >= MIN_SAMPLE)
      .sort((a, b) => b.shrunk! - a.shrunk!)[0]!
    const routed = pick('review-lens', undefined, 0, false)
    expect(routed.agent).toBe(expected.agent)
    expect(routed.reason).toContain('mean;')
  })

  test('posterior noise uses the mapped shrunk-score band at and beyond its edge', () => {
    expect(POSTERIOR_NOISE_BAND).toBeCloseTo(NOISE_BAND / BETA_SCALE)
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'full', i < 2 ? 'right' : 'mixed')
    }
    const cands = candidates('review-lens').filter((candidate) =>
      ['codex', 'grok'].includes(candidate.agent),
    )
    const selected = currentPolicySelection(cands, [], false)
    const trunkStyle = [...cands].sort((a, b) => b.shrunk! - a.shrunk!)[0]!
    const trunkBand = cands.filter(
      (candidate) => trunkStyle.shrunk! - candidate.shrunk! <= NOISE_BAND,
    )
    expect(pick('review-lens', undefined, 0, false).agent).toBe('codex')
    expect(trunkStyle.agent).toBe('codex')
    expect(trunkBand).toHaveLength(1)
    expect(selected).toMatchObject({ chosen: { agent: 'codex' }, tied: 1 })

    const candidate = (
      agent: string,
      scoreValue: number,
      shrunk: number,
      free: boolean,
      latencyMs: number,
    ) => ({
      agent,
      scored: MIN_SAMPLE,
      failures: 0,
      none: 0,
      evidence: MIN_SAMPLE,
      score: scoreValue,
      shrunk,
      free,
      latencyMs,
      precision: null,
    })
    const inside = currentPolicySelection(
      [candidate('a', 1, 0.975, false, 10_000), candidate('b', 0.9, 0.925, true, 20_000)],
      [],
      false,
    )
    expect(inside).toMatchObject({ chosen: { agent: 'b' }, tied: 2 })
  })

  test('precision below its floor is ignored and measured precision breaks a quality tie', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'full', 'right')
    }
    const calibrate = (agent: string, n: number) => {
      const runId = addRun({ agent, job: 'review-lens', lens: 'correctness' })
      const reviewId = recordReview(runId, reviewReply(n), db())
      for (let i = 1; i <= n; i++) triageFinding(reviewId, i, 'accepted')
      completeReview(reviewId)
    }
    calibrate('grok', MIN_REVIEW_TRIAGED - 1)
    expect(pick('review-lens', undefined, 0, false, null, {}, false, 'correctness').agent).toBe(
      'codex',
    )
    calibrate('grok', 1)
    const routed = pick('review-lens', undefined, 0, false, null, {}, false, 'correctness')
    expect(routed.agent).toBe('grok')
    expect(routed.reason).toContain('precision 100%')
  })

  test('high precision cannot override a quality gap outside the posterior band', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'full', 'wrong')
    }
    const runId = addRun({ agent: 'grok', job: 'review-lens', lens: 'correctness' })
    const reviewId = recordReview(runId, reviewReply(MIN_REVIEW_TRIAGED), db())
    for (let i = 1; i <= MIN_REVIEW_TRIAGED; i++) triageFinding(reviewId, i, 'accepted')
    completeReview(reviewId)
    const routed = pick('review-lens', undefined, 0, false, null, {}, false, 'correctness')
    expect(routed.agent).toBe('codex')
  })

  test('a failing default-agent eval closes exploration but not proven leading rank', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'full', 'mixed')
    }
    const evalRun = addRun({ agent: 'codex', job: 'implement', probe: 1 })
    db()
      .query(
        `INSERT INTO canon_eval (slug, run_id, canon_sha, agent, model, pass, why, at)
       VALUES ('asks-instead-of-deciding', ?, 'sha', 'codex', 'm', 0, 'built', ?)`,
      )
      .run(evalRun, nowIso())
    const random = Math.random
    Math.random = () => 0
    try {
      const protectedRoute = pick('review-lens')
      expect(protectedRoute.agent).toBe('grok')
      expect(protectedRoute.reason).toContain(
        'codex not explored: failing canon eval asks-instead-of-deciding',
      )
    } finally {
      Math.random = random
    }

    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
    }
    expect(pick('review-lens', undefined, 0, false).agent).toBe('codex')
  })

  test('a failing eval never overrides an explicit agent pin', () => {
    const evalRun = addRun({ agent: 'codex', job: 'implement', probe: 1 })
    db()
      .query(
        `INSERT INTO canon_eval (slug, run_id, canon_sha, agent, model, pass, why, at)
       VALUES ('asks-instead-of-deciding', ?, 'sha', 'codex', 'm', 0, 'built', ?)`,
      )
      .run(evalRun, nowIso())
    expect(pick('review-lens', 'codex')).toEqual({
      agent: 'codex',
      reason: 'explicit --agent',
    })
  })

  test('the standing challenger draw skips an agent with a failing eval', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'full', 'right')
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'mixed')
    }
    const evalRun = addRun({ agent: 'codex', job: 'implement', probe: 1 })
    db()
      .query(
        `INSERT INTO canon_eval (slug, run_id, canon_sha, agent, model, pass, why, at)
       VALUES ('asks-instead-of-deciding', ?, 'sha', 'codex', 'm', 0, 'built', ?)`,
      )
      .run(evalRun, nowIso())
    const random = Math.random
    Math.random = () => STANDING_EXPLORE_RATE / 2
    try {
      const routed = pick('review-lens')
      expect(routed.agent).toBe('grok')
      expect(routed.reason).not.toContain('standing challenger')
      expect(routed.reason).toContain('codex not explored: failing canon eval')
    } finally {
      Math.random = random
    }
  })

  test('a harness-failed eval run without an eval result leaves exploration open', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'full', 'right')
    }
    addRun({
      agent: 'codex',
      job: 'implement',
      probe: 1,
      status: 'failed',
      kind: 'harness',
    })
    const random = Math.random
    Math.random = () => 0
    try {
      const routed = pick('review-lens')
      expect(routed.agent).toBe('codex')
      expect(routed.reason).toContain('challenger')
      expect(routed.reason).not.toContain('not explored')
    } finally {
      Math.random = random
    }
  })

  test('two null precision cells fall through to free billing and then latency', () => {
    const candidate = (agent: string, free: boolean, latencyMs: number) => ({
      agent,
      scored: MIN_SAMPLE,
      failures: 0,
      none: 0,
      evidence: MIN_SAMPLE,
      score: 1,
      shrunk: 1,
      free,
      latencyMs,
      precision: null,
    })
    expect(
      currentPolicySelection(
        [candidate('paid-fast', false, 1_000), candidate('free-slow', true, 10_000)],
        [],
        false,
      ).chosen.agent,
    ).toBe('free-slow')
    expect(
      currentPolicySelection(
        [candidate('slow', false, 10_000), candidate('fast', false, 1_000)],
        [],
        false,
      ).chosen.agent,
    ).toBe('fast')
  })

  test('a wrong answer stays explorable, while delivery-none-only history does not', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
    }
    const wrong = addRun({ agent: 'grok', job: 'review-lens' })
    score(wrong, 'full', 'wrong')

    const random = Math.random
    Math.random = () => 0
    try {
      expect(pick('review-lens').agent).toBe('grok')
      db().query("UPDATE score SET delivery='none', quality=NULL WHERE run_id=?").run(wrong)
      expect(pick('review-lens').agent).toBe('codex')
    } finally {
      Math.random = random
    }
  })

  test('the standing draw picks a proven non-leader', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'full', 'mixed')
    }

    const random = Math.random
    Math.random = () => STANDING_EXPLORE_RATE / 2
    try {
      const routed = pick('review-lens')
      expect(routed.agent).toBe('grok')
      expect(routed.reason).toContain('standing challenger')
    } finally {
      Math.random = random
    }
  })

  test('the standing exploration floor decays with the leader cell evidence', () => {
    expect(standingExploreRate(MIN_SAMPLE)).toBe(0.1)
    expect(standingExploreRate(4 * MIN_SAMPLE)).toBe(0.05)
    expect(standingExploreRate(EVIDENCE_WINDOW)).toBe(Math.max(0.03, 0.1 / Math.sqrt(8)))
  })

  test('the standing draw skips a challenger whose scored history is all none', () => {
    for (let i = 0; i < MIN_SAMPLE; i++) {
      score(addRun({ agent: 'codex', job: 'review-lens' }), 'full', 'right')
      score(addRun({ agent: 'grok', job: 'review-lens' }), 'none')
    }

    const random = Math.random
    Math.random = () => 0
    try {
      expect(pick('review-lens').agent).toBe('codex')
    } finally {
      Math.random = random
    }
  })
})
