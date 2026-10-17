import { expect, test } from 'bun:test'
import { checkSqlLiteralSchema } from './check-sql-literal-schema.ts'

test('production SQLite SQL literals prepare against the fully migrated schemas', () => {
  const result = checkSqlLiteralSchema()
  expect(result.prepared.orchestrator).toBeGreaterThan(0)
  expect(result.prepared.hub).toBeGreaterThan(0)
})
