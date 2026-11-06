import { expect, test } from 'bun:test'
import { directOutboxInsertViolations } from './check-outbox-insert-site.ts'

test('flags a direct outbox insert outside the enqueue module', () => {
  expect(
    directOutboxInsertViolations(
      "database.query('INSERT INTO outbox (record_id) VALUES (?)')",
      'orchestrator/src/run/example.ts',
    ),
  ).toEqual(['orchestrator/src/run/example.ts:1: use record/outbox-enqueue.ts'])
})

test.each(['INSERT OR REPLACE', 'INSERT OR IGNORE', 'REPLACE'])(
  'flags %s INTO outbox outside the enqueue module',
  (operation) => {
    expect(
      directOutboxInsertViolations(
        `database.query('${operation} INTO outbox (record_id) VALUES (?)')`,
        'orchestrator/src/run/example.ts',
      ),
    ).toEqual(['orchestrator/src/run/example.ts:1: use record/outbox-enqueue.ts'])
  },
)

test('an apostrophe in an earlier comment does not hide a re-pending update', () => {
  expect(
    directOutboxInsertViolations(
      "// It doesn't matter here.\ndatabase.query('UPDATE outbox SET attempts=0 WHERE id=?')",
      'orchestrator/src/run/example.ts',
    ),
  ).toEqual(['orchestrator/src/run/example.ts:2: use record/outbox-enqueue.ts'])
})

test('flags a payload-only pending outbox update outside its owners', () => {
  expect(
    directOutboxInsertViolations(
      "database.query('UPDATE outbox SET payload=?,created_at=? WHERE id=?')",
      'orchestrator/src/run/example.ts',
    ),
  ).toEqual([
    'orchestrator/src/run/example.ts:1: use record/outbox-enqueue.ts or record/outbox-prune.ts',
  ])
})

test('quarantine clearing is refused outside its owners', () => {
  expect(
    directOutboxInsertViolations(
      "database.query('UPDATE outbox SET quarantined_at=NULL,last_error=NULL WHERE id=?')",
      'orchestrator/src/run/example.ts',
    ),
  ).toEqual([
    'orchestrator/src/run/example.ts:1: use record/outbox-enqueue.ts or record/outbox-quarantine.ts',
  ])
})

test('quarantine clearing is allowed in the quarantine owner', () => {
  expect(
    directOutboxInsertViolations(
      "database.query('UPDATE outbox SET quarantined_at=NULL,last_error=NULL WHERE id=?')",
      'orchestrator/src/record/outbox-quarantine.ts',
    ),
  ).toEqual([])
})

test('allows an outbox payload-only prune update', () => {
  expect(
    directOutboxInsertViolations(
      "database.query('UPDATE outbox SET payload=? WHERE id=?')",
      'orchestrator/src/record/outbox-prune.ts',
    ),
  ).toEqual([])
})

test.each([
  'UPDATE outbox SET attempts=attempts+1,last_error=? WHERE id=?',
  'UPDATE outbox SET synced_at=?,last_error=NULL WHERE id=?',
])('allows outbox bookkeeping updates anywhere: %s', (statement) => {
  expect(
    directOutboxInsertViolations(
      `database.query('${statement}')`,
      'orchestrator/src/run/example.ts',
    ),
  ).toEqual([])
})
