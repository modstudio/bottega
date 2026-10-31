import { expect, test } from 'bun:test'
import { migrationFailure } from './migration-failure.ts'

test('reports the postgres cause and code for the matching migration', () => {
  const query = 'ALTER TABLE "doc_revision" ADD CONSTRAINT "doc_revision_x_check" CHECK (x > 0);'
  const cause = Object.assign(
    new Error(
      'new row for relation "doc_revision" violates check constraint "doc_revision_x_check"',
    ),
    { code: '23514' },
  )
  const error = Object.assign(new Error(`Failed query: ${query} params:`), { query, cause })
  const migrations = new Map([
    ['20261030000000_unrelated', 'SELECT 1;'],
    ['20261031000000_doc_revision_check', `BEGIN;\n${query}\nCOMMIT;`],
  ])

  const failure = migrationFailure(error, [...migrations.keys()], (name) => migrations.get(name)!)

  expect(failure).toContain('migration 20261031000000_doc_revision_check statement')
  expect(failure).toContain(cause.message)
  expect(failure).toContain('(code 23514)')
})

test('reports a plain error message', () => {
  expect(migrationFailure(new Error('migration connection closed'), [], () => '')).toBe(
    'migration <unknown> statement <unknown>: migration connection closed',
  )
})
