import { describe, expect, test } from 'bun:test'
import { bradleyTerry, gwetAc1 } from './agreement.ts'

describe('routing agreement statistics', () => {
  test('Gwet AC1 matches a hand-computed three-category table', () => {
    // Agreement is 3/4. Combined marginals are 5/8, 1/4, 1/8, so chance
    // agreement is 17/64 and AC1 is (48/64 - 17/64) / (1 - 17/64) = 31/47.
    const pairs = [
      ['a', 'a'],
      ['a', 'a'],
      ['b', 'b'],
      ['c', 'a'],
    ] as const
    expect(gwetAc1(pairs, ['a', 'b', 'c'])).toBeCloseTo(31 / 47)
  })

  test('Bradley-Terry orders known duel strengths and the pseudo-duel prior keeps finite values', () => {
    const evidence: Record<string, Record<string, number>> = {
      alpha: { beta: 4, gamma: 3 },
      beta: { alpha: 1, gamma: 3 },
      gamma: { alpha: 0, beta: 1 },
    }
    const fitted = bradleyTerry(
      ['alpha', 'beta', 'gamma'],
      (winner, loser) => evidence[winner]?.[loser] ?? 0,
    )
    expect(fitted.map((row) => row.agent)).toEqual(['alpha', 'beta', 'gamma'])
    expect(fitted.every((row) => Number.isFinite(row.strength) && row.strength > 0)).toBe(true)
    expect(fitted.reduce((sum, row) => sum + row.strength, 0)).toBeCloseTo(3, 10)

    const separated = bradleyTerry(['winner', 'loser'], (winner) => (winner === 'winner' ? 100 : 0))
    expect(separated.every((row) => Number.isFinite(row.strength) && row.strength > 0)).toBe(true)
  })
})
