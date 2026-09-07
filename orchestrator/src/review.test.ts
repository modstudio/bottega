import { describe, expect, test } from 'bun:test'
import { FIDELITY_PENALTY, addRun, candidates, score, weigh } from '../test/fixture.ts'

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
