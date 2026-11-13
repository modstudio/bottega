import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

test('review funnel decision migration stores replay facts and stack', () => {
  const database = migrationBoundaryTestDatabase('0223_review_funnel_decision')
  expect(applyMigrations(database)).toContain('0223_review_funnel_decision')
  const columns = database
    .query<{ name: string }, []>('PRAGMA table_info(review_funnel_decision)')
    .all()
    .map(({ name }) => name)
  expect(columns).toContain('facts')
  expect(columns).toContain('stack')
  expect(columns).toContain('verdict')
  database.close()
})
