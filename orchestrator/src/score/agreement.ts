/** Gwet's unweighted AC1 for two raters using the same finite category set. */
export function gwetAc1(
  pairs: readonly (readonly [string, string])[],
  levels: readonly string[],
): number | null {
  if (!pairs.length || levels.length < 2) return null
  const n = pairs.length
  const observed = pairs.filter(([a, b]) => a === b).length / n
  const marginals = levels.map(
    (level) =>
      (pairs.filter(([a]) => a === level).length + pairs.filter(([, b]) => b === level).length) /
      (2 * n),
  )
  const expected = marginals.reduce((sum, p) => sum + p * (1 - p), 0) / (levels.length - 1)
  return expected === 1 ? null : (observed - expected) / (1 - expected)
}

/** Quadratic-weighted Cohen's kappa for an ordered three-level rubric. */
export function quadraticWeightedKappa(
  pairs: readonly (readonly [string, string])[],
  levels: readonly string[],
): number | null {
  if (!pairs.length) return null
  const countsA = levels.map((level) => pairs.filter((pair) => pair[0] === level).length)
  const countsB = levels.map((level) => pairs.filter((pair) => pair[1] === level).length)
  const distance = (a: string, b: string) => {
    const d = levels.indexOf(a) - levels.indexOf(b)
    return (d * d) / (levels.length - 1) ** 2
  }
  const observed = pairs.reduce((sum, pair) => sum + distance(pair[0], pair[1]), 0) / pairs.length
  let expected = 0
  for (let a = 0; a < levels.length; a++)
    for (let b = 0; b < levels.length; b++) {
      expected += countsA[a]! * countsB[b]! * distance(levels[a]!, levels[b]!)
    }
  expected /= pairs.length * pairs.length
  return expected === 0 ? null : 1 - observed / expected
}

export type BradleyTerryStrength = { agent: string; strength: number }

/** Hunter (2004) iterative minorisation, regularized by one split pseudo-duel per pair. */
export function bradleyTerry(
  agents: readonly string[],
  wins: (winner: string, loser: string) => number,
): BradleyTerryStrength[] {
  if (!agents.length) return []
  let strengths = agents.map(() => 1)
  for (let iteration = 0; iteration < 10_000; iteration++) {
    const next = agents.map((agent, i) => {
      let numerator = 0
      let denominator = 0
      for (let j = 0; j < agents.length; j++) {
        if (i === j) continue
        const opponent = agents[j]!
        // Half a win in each direction is one uniform pseudo-duel for the pair.
        numerator += wins(agent, opponent) + 0.5
        const comparisons = wins(agent, opponent) + wins(opponent, agent) + 1
        denominator += comparisons / (strengths[i]! + strengths[j]!)
      }
      return denominator === 0 ? 1 : numerator / denominator
    })
    const mean = next.reduce((sum, value) => sum + value, 0) / next.length
    const normalized = next.map((value) => value / mean)
    const change = Math.max(...normalized.map((value, i) => Math.abs(value - strengths[i]!)))
    strengths = normalized
    if (change < 1e-12) break
  }
  return agents
    .map((agent, i) => ({ agent, strength: strengths[i]! }))
    .sort((a, b) => b.strength - a.strength || a.agent.localeCompare(b.agent))
}
