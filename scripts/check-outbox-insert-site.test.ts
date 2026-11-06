import { expect, test } from 'bun:test'
import { directOutboxInsertViolations } from './check-outbox-insert-site.ts'

test('flags a direct outbox insert outside the enqueue module', () => {
  expect(
    directOutboxInsertViolations(
      "database.query('INSERT INTO outbox (record_id) VALUES (?)')",
      'orchestrator/src/run/example.ts',
    ),
  ).toEqual(['orchestrator/src/run/example.ts:1'])
})

test.each(['INSERT OR REPLACE', 'INSERT OR IGNORE', 'REPLACE'])(
  'flags %s INTO outbox outside the enqueue module',
  (operation) => {
    expect(
      directOutboxInsertViolations(
        `database.query('${operation} INTO outbox (record_id) VALUES (?)')`,
        'orchestrator/src/run/example.ts',
      ),
    ).toEqual(['orchestrator/src/run/example.ts:1'])
  },
)
