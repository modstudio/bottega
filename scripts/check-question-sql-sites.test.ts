import { expect, test } from 'bun:test'
import { questionSqlViolations } from './check-question-sql-sites.ts'

test('question SQL is refused in callers and allowed in adapters', () => {
  expect(
    questionSqlViolations(
      'const row = db.query(`SELECT * FROM question`).get()',
      'orchestrator/src/run/caller.ts',
    ),
  ).toEqual(['orchestrator/src/run/caller.ts:1: use the question-store port'])
  expect(
    questionSqlViolations('SELECT * FROM question', 'orchestrator/src/question-store/adapter.ts'),
  ).toEqual([])
})
