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
