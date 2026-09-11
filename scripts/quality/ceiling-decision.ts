export type CeilingDecision = 'pass' | 'lower' | 'remove' | 'fail'

export type CeilingInput = {
  key: string
  value: number
  frozen: number | undefined
  ceiling: number
}

/** Decide a shrink-only ceiling without knowing how its measurements are gathered. */
export function decideCeiling({ value, frozen, ceiling }: CeilingInput): CeilingDecision {
  if (value <= ceiling) return frozen === undefined ? 'pass' : 'remove'
  if (frozen === undefined || value > frozen) return 'fail'
  if (value < frozen) return 'lower'
  return 'pass'
}
