export type TestTimingDecision = 'initial' | 'pass' | 'tighten' | 'fail'

export const TEST_FILE_WALL_CEILING_MS = 3_000
export const SINGLE_TEST_WALL_CEILING_MS = 1_000

type TimedFile = { file: string; wallMs: number }
type TimedTest = { file: string; name: string; wallMs: number }

export type TestTimingRunDecision = {
  growth: 'compare' | 'skip-sharded'
  longPoles: string[]
}

export function longPoleFailures(files: TimedFile[], tests: TimedTest[]): string[] {
  return [
    ...files
      .filter((file) => file.file.endsWith('.test.ts') && file.wallMs > TEST_FILE_WALL_CEILING_MS)
      .map(
        (file) =>
          `${file.file} ${Math.round(file.wallMs)}ms exceeds test file ceiling ${TEST_FILE_WALL_CEILING_MS}ms`,
      ),
    ...tests
      .filter((test) => test.wallMs > SINGLE_TEST_WALL_CEILING_MS)
      .map(
        (test) =>
          `${test.file}: ${test.name} ${Math.round(test.wallMs)}ms exceeds single test ceiling ${SINGLE_TEST_WALL_CEILING_MS}ms`,
      ),
  ]
}

/** Keep absolute ceilings authoritative while comparing growth only for like-for-like runs. */
export function decideTestTimingRun({
  sharded,
  files,
  tests,
}: {
  sharded: boolean
  files: TimedFile[]
  tests: TimedTest[]
}): TestTimingRunDecision {
  return {
    growth: sharded ? 'skip-sharded' : 'compare',
    longPoles: longPoleFailures(files, tests),
  }
}

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

export type BaselineDisposition = 'write' | 'report' | 'keep'

/**
 * What to do with a measurement that would move the committed baseline. A
 * local run writes it and asks for the commit; a hosted runner is a different
 * machine, so its measurement is reported and never written or made a verdict.
 */
export function baselineDisposition({
  changed,
  ci,
}: {
  changed: boolean
  ci: boolean
}): BaselineDisposition {
  if (!changed) return 'keep'
  return ci ? 'report' : 'write'
}
