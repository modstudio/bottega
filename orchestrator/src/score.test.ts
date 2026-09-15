import { describe, expect, test } from 'bun:test'
import { addRun, score } from '../test/fixtures/store.ts'
import { candidates } from './route.ts'
import { FIDELITY_PENALTY, judgeability, weigh } from './score.ts'

describe('fidelity: did it build what it was asked to build', () => {
  test('correct code that solved the wrong problem is not a perfect run', () => {
    // The failure neither existing axis can see. A complete change set of
    // correct, working code that answers a different question scores full/right
    // on both, and only fidelity registers that it is not what was asked for.
    expect(weigh('full', 'right')).toBe(1)
    expect(weigh('full', 'right', 'drifted')).toBe(0.5)
    expect(weigh('full', 'right', 'faithful')).toBe(1)
  })

  test('asking costs an agent nothing', () => {
    // Load-bearing: the preamble promises the worker that escalating is free.
    // If it were not, asking would cost something after all and nobody would ask.
    expect(FIDELITY_PENALTY.faithful).toBe(0)
  })

  test('a score with no fidelity weighs exactly what it always did', () => {
    // Adding the axis must not restate history. Every read-only job, and every
    // verdict recorded before the column existed, is unaffected.
    for (const d of ['none', 'partial', 'full'] as const) {
      for (const q of ['wrong', 'mixed', 'right'] as const) {
        if (d === 'none') continue
        expect(weigh(d, q, null)).toBe(weigh(d, q))
      }
    }
    expect(weigh('none', null, null)).toBe(weigh('none', null))
  })

  test('the router reads the penalty, not just the printout', () => {
    // The failure this file already documents once: stats, the dashboard and
    // the router each held their own copy of the aggregate and drifted apart.
    const drifted = addRun({ agent: 'codex', job: 'implement' })
    score(drifted, 'full', 'right', 'drifted')
    const c = candidates('implement').find((x) => x.agent === 'codex')!
    expect(c.score).toBeCloseTo(weigh('full', 'right', 'drifted'))
    expect(c.score).toBeLessThan(weigh('full', 'right'))
  })

  test('an agent that drifts ranks below one that asks', () => {
    const asked = addRun({ agent: 'codex', job: 'implement' })
    score(asked, 'full', 'right', 'faithful')
    const guessed = addRun({ agent: 'grok', job: 'implement' })
    score(guessed, 'full', 'right', 'drifted')
    const all = candidates('implement')
    const a = all.find((x) => x.agent === 'codex')!
    const g = all.find((x) => x.agent === 'grok')!
    expect(a.score!).toBeGreaterThan(g.score!)
  })
})

describe('the fidelity penalty cannot sink below "nothing arrived"', () => {
  test('a delivered answer never ranks below a non-delivery', () => {
    // Unclamped, partial/wrong/drifted weighs -0.75 against none's -0.5, so an
    // agent that delivered something unusable ranked BELOW one that delivered
    // nothing — and routing would prefer the agent that cannot do the job.
    const floor = weigh('none', null)
    for (const d of ['partial', 'full'] as const) {
      for (const q of ['wrong', 'mixed', 'right'] as const) {
        for (const f of ['drifted', 'partial', 'faithful'] as const) {
          expect(weigh(d, q, f)).toBeGreaterThanOrEqual(floor)
        }
      }
    }
  })

  test('the router clamps identically to the printout', () => {
    const bad = addRun({ agent: 'codex', job: 'implement' })
    score(bad, 'partial', 'wrong', 'drifted')
    const c = candidates('implement').find((x) => x.agent === 'codex')!
    expect(c.score).toBeCloseTo(weigh('partial', 'wrong', 'drifted'))
    expect(c.score).toBeGreaterThanOrEqual(weigh('none', null))
  })

  test('an unknown fidelity is refused rather than read as no penalty', () => {
    // addColumn cannot carry a CHECK, so a typo reaches weigh() on any database
    // that predates the column. Silently scoring it as faithful would flatter
    // the run and diverge from the SQL, which treats it as zero.
    expect(() => weigh('full', 'right', 'faithfull' as never)).toThrow()
  })
})

describe('who may judge a run', () => {
  // The rule was already written in AGENTS.md and did not hold: on 2026-08-31 two
  // concurrent sessions each scored the other's runs within an hour, both having
  // inferred their ids from their own previous block rather than reading them
  // back. These pin the guard that turns that prose into a refusal.

  test('the session that made a run may score it', () => {
    expect(judgeability('session-A', 'session-A')).toEqual({ verdict: 'own' })
  })

  test('another session may NOT — it never read the output', () => {
    expect(judgeability('session-A', 'session-B')).toEqual({
      verdict: 'foreign',
      owner: 'session-A',
    })
  })

  test('the owner travels with the refusal, so the error can name who to ask', () => {
    // Without this the message could only say "not yours", which does not tell
    // anyone what to do next. Naming the session is what makes SendMessage the
    // obvious move rather than --force.
    const v = judgeability('session-A', 'session-B')
    expect(v.verdict === 'foreign' && v.owner).toBe('session-A')
  })

  test('a run recorded before session ids is scoreable by anyone', () => {
    // Refusing these would strand every run made before session_id existed.
    // Missing evidence is not evidence of wrongdoing.
    expect(judgeability(null, 'session-A')).toEqual({ verdict: 'unattributed' })
    expect(judgeability(null, null)).toEqual({ verdict: 'unattributed' })
  })

  test('a caller with no session id is warned, not blocked', () => {
    // Scoring from a plain shell is legitimate; it just cannot be verified.
    expect(judgeability('session-A', null)).toEqual({
      verdict: 'anonymous',
      owner: 'session-A',
    })
  })
})

describe('what the views print beside a percentage', () => {
  test('a failure-only cell has a negative mean, which a bar cannot render', () => {
    // The router is entitled to a negative score. `width:-50%` renders as
    // nothing, with no hint that the cell is bad rather than empty.
    addRun({ agent: 'agy', job: 'craft', status: 'failed' })
    const c = candidates('craft').find((x) => x.agent === 'agy')!
    expect(c.score).toBeLessThan(0)
    const pct = Math.round(c.score! * 100)
    expect(Math.max(0, Math.min(100, pct))).toBe(0)
  })
  test('evidence is what MIN_SAMPLE counts, so it is what a surface must print', () => {
    // One good verdict plus two unjudged failures: the mean is 0 over THREE
    // judgements. A surface printing "0% of 1" beside it is incoherent — a 0%
    // on a single `right` verdict cannot happen.
    score(addRun({ agent: 'agy', job: 'review-lens-inline' }), 'full', 'right')
    addRun({ agent: 'agy', job: 'review-lens-inline', status: 'failed' })
    addRun({ agent: 'agy', job: 'review-lens-inline', status: 'stale' })
    const c = candidates('review-lens-inline').find((x) => x.agent === 'agy')!
    expect(c.score).toBe(0)
    expect(c.scored).toBe(1)
    expect(c.evidence).toBe(3)
  })
})
