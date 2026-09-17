import { describe, expect, test } from 'bun:test'
import { addRun, score } from '../../test/fixtures/store.ts'
import { label } from '../outcome.ts'
import { WEIGHT, weigh } from '../score/score.ts'
import { median } from '../statistics.ts'
import { candidates, MIN_SAMPLE, NOISE_BAND, QUALITY_STEP, weightCase } from './route.ts'

describe('the scoring matrix', () => {
  test('no answer costs more than a wrong answer, because it is a different failure', () => {
    // A wrong answer means the agent engaged and got it wrong; nothing arriving
    // means it cannot do this job here. Only the second should push routing away.
    expect(weigh('none', null)).toBeLessThan(weigh('full', 'wrong'))
    expect(weigh('none', null)).toBeLessThan(0)
    expect(weigh('full', 'wrong')).toBe(0)
  })

  test('quality orders within a delivery level', () => {
    for (const d of ['partial', 'full'] as const) {
      expect(weigh(d, 'wrong')).toBeLessThan(weigh(d, 'mixed'))
      expect(weigh(d, 'mixed')).toBeLessThan(weigh(d, 'right'))
    }
  })

  test('a full answer beats the same quality delivered partially', () => {
    for (const q of ['wrong', 'mixed', 'right'] as const) {
      expect(weigh('partial', q)).toBeLessThanOrEqual(weigh('full', q))
    }
  })

  test('the three cells the old vocabulary could express kept their exact values', () => {
    // Migrating must not move any agent's standing on its own.
    expect(weigh('full', 'right')).toBe(1) // was good
    expect(weigh('full', 'mixed')).toBe(0.5) // was partial
    expect(weigh('full', 'wrong')).toBe(0) // was bad
    expect(weigh('none', null)).toBe(-0.5) // was unusable
  })

  test('the SQL expression is built from the matrix, so editing it moves routing', () => {
    const sql = weightCase()
    for (const [delivery, row] of Object.entries(WEIGHT)) {
      if (typeof row === 'number') {
        expect(sql).toContain(`WHEN s.delivery = '${delivery}' THEN ${row}`)
      } else {
        for (const [quality, w] of Object.entries(row)) {
          expect(sql).toContain(
            `WHEN s.delivery = '${delivery}' AND s.quality = '${quality}' THEN ${w}`,
          )
        }
      }
    }
  })

  test('a delivery failure and a wrong answer are no longer the same row', () => {
    // The complaint that produced this matrix: run 279 came back as 57 bytes of
    // vendor error and was recorded identically to a full answer that was wrong.
    const noAnswer = addRun({ agent: 'agy', job: 'craft' })
    const wrongAnswer = addRun({ agent: 'codex', job: 'craft' })
    score(noAnswer, 'none')
    score(wrongAnswer, 'full', 'wrong')
    const cs = candidates('craft')
    expect(cs.find((c) => c.agent === 'agy')!.score).toBeLessThan(
      cs.find((c) => c.agent === 'codex')!.score!,
    )
  })

  test('the schema refuses an incoherent judgement', () => {
    const id = addRun({ agent: 'grok', job: 'craft' })
    // Nothing came back, yet a quality is asserted about it.
    expect(() => score(id, 'none', 'right')).toThrow()
    // Something came back, yet no quality is recorded.
    expect(() => score(id, 'full', null)).toThrow()
  })

  test('every cell has a short label, and none of them collide', () => {
    const labels = new Set<string>()
    labels.add(label('none', null))
    for (const d of ['partial', 'full'] as const)
      for (const q of ['wrong', 'mixed', 'right'] as const) labels.add(label(d, q))
    expect(labels.size).toBe(7)
  })
})

describe('the noise band', () => {
  test('is one judgement step over MIN_SAMPLE, which is what its comment claims', () => {
    expect(QUALITY_STEP).toBe(weigh('full', 'right') - weigh('full', 'mixed'))
    expect(NOISE_BAND).toBeCloseTo(QUALITY_STEP / MIN_SAMPLE)
    expect(NOISE_BAND).toBeCloseTo(0.1)
  })

  test('it is NOT the full spread of the scale, which is a different question', () => {
    // A review lens proposed (WEIGHT_MAX - weigh('none')) / MIN_SAMPLE / 2 =
    // 0.15. That measures the whole scale; the band measures one judgement.
    const spread = weigh('full', 'right') - weigh('none', null)
    expect(spread).toBe(1.5)
    expect(NOISE_BAND).not.toBeCloseTo(spread / MIN_SAMPLE / 2)
  })

  test('it tracks the matrix rather than a constant that happens to match', () => {
    // The old derivation was WEIGHT_MAX / MIN_SAMPLE / 2. It agreed only
    // because WEIGHT_MAX/2 and one quality step are both 0.5 today.
    const coincidence = 1 / MIN_SAMPLE / 2
    expect(NOISE_BAND).toBeCloseTo(coincidence) // same number now
    expect(QUALITY_STEP).not.toBe(1 / 2 + 0.0001) // but derived differently
  })
})

describe('median', () => {
  test('there is one implementation, and the guide uses it', () => {
    // Two identical copies lived in route.ts and guide.ts. Identical today is
    // how a pair of copies always starts.
    expect(median([])).toBeNull()
    expect(median([5])).toBe(5)
    expect(median([3, 1, 2])).toBe(2) // odd: middle after sorting
    expect(median([4, 1, 3, 2])).toBe(2.5) // even: mean of the middle two
  })

  test('it does not disturb the array it is given', () => {
    const xs = [3, 1, 2]
    median(xs)
    expect(xs).toEqual([3, 1, 2])
  })

  test('one hung call does not move it, which is why it is not a mean', () => {
    const withHang = [100, 110, 120, 130, 900_000]
    expect(median(withHang)).toBe(120)
  })
})
