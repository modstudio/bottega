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
