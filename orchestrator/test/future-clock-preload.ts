// Guarded fixtures compare instants against the clock, never a fixed date: production stamps cursor
// steps from the real clock, so scripts/check-plan.ts runs this preload to catch wall-clock outgrowth.
import { setSystemTime } from 'bun:test'
import { FUTURE_CLOCK_TEST_INSTANT } from './gate-test-selection.ts'

setSystemTime(new Date(FUTURE_CLOCK_TEST_INSTANT))
