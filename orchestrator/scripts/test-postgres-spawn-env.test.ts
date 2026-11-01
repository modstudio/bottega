import { describe, expect, test } from 'bun:test'
import { STATE_HOME_ENV } from '../../shared/state-directory.ts'
import { testPostgresSpawnEnvironment } from './test-postgres-spawn-env.ts'

describe('testPostgresSpawnEnvironment', () => {
  test('confines state and preserves the record environment boundary', () => {
    const child = testPostgresSpawnEnvironment(
      {
        [STATE_HOME_ENV]: '/operator/state',
        BOTTEGA_ORCHESTRATOR_DB: '/operator/orchestrator.db',
        BOTTEGA_RUNS: '/operator/runs',
        BOTTEGA_HUB_DB: '/operator/hub.db',
        BOTTEGA_RECORD_API_URL: 'https://inherited.example.test',
        BOTTEGA_RECORD_URL: 'postgres://inherited',
        PATH: '/bin',
      },
      '/tmp/test-state',
      {
        [STATE_HOME_ENV]: '/caller/state',
        BOTTEGA_ORCHESTRATOR_DB: '/caller/orchestrator.db',
        BOTTEGA_RUNS: '/caller/runs',
        BOTTEGA_HUB_DB: '/caller/hub.db',
        BOTTEGA_RECORD_API_URL: 'https://caller.example.test',
      },
    )

    expect(child).toEqual({
      [STATE_HOME_ENV]: '/tmp/test-state',
      BOTTEGA_RECORD_API_URL: 'https://caller.example.test',
      PATH: '/bin',
    })
  })
})
