// Guarded fixtures compare instants against the clock, never a fixed date: production stamps cursor
// steps from the real clock, so scripts/check-plan.ts runs this preload to catch wall-clock outgrowth.
import { setSystemTime } from 'bun:test'

/**
 * The guard stays later than fixed fixture dates in FUTURE_CLOCK_GUARDED_TESTS and earlier than
 * the tree's 2099 never-expires sentinels.
 */
const FUTURE_CLOCK_TEST_INSTANT = '2090-01-01T00:00:00.000Z'

setSystemTime(new Date(FUTURE_CLOCK_TEST_INSTANT))
