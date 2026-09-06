/** Gwet's unweighted AC1 for two raters using the same finite category set. */
export function gwetAc1(pairs: readonly (readonly [string, string])[], levels: readonly string[]): number | null {
  if (!pairs.length || levels.length < 2) return null
  const n = pairs.length
  const observed = pairs.filter(([a, b]) => a === b).length / n
  const marginals = levels.map((level) => (
    pairs.filter(([a]) => a === level).length + pairs.filter(([, b]) => b === level).length
  ) / (2 * n))
  const expected = marginals.reduce((sum, p) => sum + p * (1 - p), 0) / (levels.length - 1)
  return expected === 1 ? null : (observed - expected) / (1 - expected)
}
