export type TestTimingDecision = 'initial' | 'pass' | 'tighten' | 'fail'

type TestTimingInput = {
  currentMs: number
  committedMs: number | undefined
  growthLimit: number
}

/**
 * Decide a tightening wall-time ratchet without knowing how timings are gathered.
 * A measurement inside the growth band on either side is machine variance and
 * passes; the baseline tightens only when the suite is faster by more than the
 * band, so an ordinary run cannot rewrite the baseline and fail on its own noise.
 */
export function decideTestTiming({
  currentMs,
  committedMs,
  growthLimit,
}: TestTimingInput): TestTimingDecision {
  if (committedMs === undefined) return 'initial'
  if (currentMs < committedMs * (1 - growthLimit)) return 'tighten'
  if (currentMs > committedMs * (1 + growthLimit)) return 'fail'
  return 'pass'
}
