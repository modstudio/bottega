import { expect, test } from 'bun:test'
import { SUBSCRIPTION_PACING_FACTS_SQL } from '../route/subscription-pacing-store.ts'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

test('run quota window migration adds the bounded-reading index', () => {
  const database = migrationBoundaryTestDatabase('0178_run_quota_window_index')
  try {
    expect(applyMigrations(database)).toContain('0178_run_quota_window_index')
    expect(
      database
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master WHERE type='index' AND name='run_quota_window_readings'`,
        )
        .get(),
    ).toEqual({ name: 'run_quota_window_readings' })
    const now = Date.now() / 1000
    const plan = database
      .query<{ detail: string }, [string, number, number, number, number, number, number]>(
        `EXPLAIN QUERY PLAN ${SUBSCRIPTION_PACING_FACTS_SQL}`,
      )
      .all(JSON.stringify(['codex']), 8, 3, now, now, now, now)
      .map((row) => row.detail)
    expect(plan.some((detail) => detail.includes('run_quota_window_readings'))).toBeTrue()
  } finally {
    database.close()
  }
})
