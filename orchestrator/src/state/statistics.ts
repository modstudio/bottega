// concern: statistics
/** Knows small descriptive statistics over plain values. Must import nothing. */

/**
 * Median, exported because the guide needs the same one.
 *
 * Median rather than mean throughout: one call that hung should not decide
 * anything. There were two identical copies of this; identical today is how a
 * pair of copies always starts.
 */
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const v = [...xs].sort((a, b) => a - b)
  const mid = v.length >> 1
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2
}

/** Returns the nearest-rank percentile of the supplied values. */
export function nearestRankPercentile(
  values: readonly number[],
  proportion: number,
): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(proportion * sorted.length) - 1)]!
}
