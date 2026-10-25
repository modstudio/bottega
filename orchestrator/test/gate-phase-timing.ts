import { SINGLE_TEST_WALL_CEILING_MS } from '../../scripts/quality/test-timing-decision.ts'

const SLOW_TEST_PHASE_TOTAL_THRESHOLD_MS = SINGLE_TEST_WALL_CEILING_MS

export type TestPhaseTiming = {
  setupMs: number
  teardownMs: number
}

export function slowTestPhaseReport(
  test: { file: string; name: string } & TestPhaseTiming,
): string | null {
  const totalMs = test.setupMs + test.teardownMs
  if (totalMs <= SLOW_TEST_PHASE_TOTAL_THRESHOLD_MS) return null
  return `${test.file}: ${test.name} fixture phases ${Math.round(totalMs)}ms (setup ${Math.round(test.setupMs)}ms, teardown ${Math.round(test.teardownMs)}ms) exceed reporting threshold ${SLOW_TEST_PHASE_TOTAL_THRESHOLD_MS}ms`
}
