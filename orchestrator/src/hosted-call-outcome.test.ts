import { expect, test } from 'bun:test'
import { migratedTestDatabase } from './database/test-database.fixture.ts'
import {
  HOSTED_CALL_OUTCOME_KEEP_MS,
  pruneHostedCallOutcomes,
  recordHostedCallOutcome,
} from './hosted-call-outcome.ts'

test('pruning hosted outcomes removes only rows older than retention', () => {
  const database = migratedTestDatabase()
  const now = Date.parse('2026-11-08T12:00:00.000Z')
  try {
    recordHostedCallOutcome(
      {
        observedAt: new Date(now - HOSTED_CALL_OUTCOME_KEEP_MS - 1).toISOString(),
        routeClass: 'record-docs',
        httpStatus: 503,
        transportError: null,
        latencyMs: 12,
      },
      database,
    )
    recordHostedCallOutcome(
      {
        observedAt: new Date(now - HOSTED_CALL_OUTCOME_KEEP_MS + 1).toISOString(),
        routeClass: 'record-docs',
        httpStatus: 200,
        transportError: null,
        latencyMs: 8,
      },
      database,
    )

    expect(pruneHostedCallOutcomes(database, now, false)).toEqual({ rows: 1 })
    expect(
      database
        .query('SELECT route_class,http_status FROM hosted_call_outcome ORDER BY observed_at')
        .all(),
    ).toEqual([{ route_class: 'record-docs', http_status: 200 }])
  } finally {
    database.close()
  }
})
