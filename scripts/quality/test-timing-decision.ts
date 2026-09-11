export type TestTimingDecision = 'initial' | 'pass' | 'tighten' | 'fail'

type TestTimingInput = {
  currentMs: number
  committedMs: number | undefined
  growthLimit: number
}

/** Decide a tightening wall-time ratchet without knowing how timings are gathered. */
export function decideTestTiming({
  currentMs,
  committedMs,
  growthLimit,
}: TestTimingInput): TestTimingDecision {
  if (committedMs === undefined) return 'initial'
  if (currentMs < committedMs) return 'tighten'
  if (currentMs > committedMs * (1 + growthLimit)) return 'fail'
  return 'pass'
}
