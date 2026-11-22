export const ORCHESTRATOR_GATE_TEST_SELECTION = {
  directories: [
    { selector: './src', reach: 'orchestrator/src' },
    { selector: './scripts', reach: 'orchestrator/scripts' },
    { selector: './test', reach: 'orchestrator/test' },
  ],
  exclusions: [
    { ignore: 'src/postgres/**', reachDirectory: 'orchestrator/src/postgres' },
    {
      ignore: 'src/record/*-postgres.test.ts',
      reachPattern: 'orchestrator/src/record/*-postgres.test.ts',
    },
  ],
} as const

/** A listed test must pass with the clock later than every fixed fixture date it contains. */
export const FUTURE_CLOCK_GUARDED_TESTS = [
  {
    selector: './src/session/context-review.test.ts',
    reach: 'orchestrator/src/session/context-review.test.ts',
  },
  { selector: './src/judgment.test.ts', reach: 'orchestrator/src/judgment.test.ts' },
] as const

/**
 * The guard stays later than fixed fixture dates in FUTURE_CLOCK_GUARDED_TESTS and earlier than
 * the tree's 2099 never-expires sentinels.
 */
export const FUTURE_CLOCK_TEST_INSTANT = '2090-01-01T00:00:00.000Z'
