import { expect, test } from 'bun:test'
import { DOC_LOCAL_SQL_ALLOWANCES, docLocalSqlViolation } from './check-doc-local-sql-authority.ts'

const query = "db().query('SELECT * FROM doc WHERE slug=?')"

test('document SQL outside the allow-list is refused', () => {
  expect(docLocalSqlViolation('orchestrator/src/run/unsafe.ts', query)).toContain(
    'document-table SQL',
  )
})

test('document SQL in an allow-listed local store is accepted', () => {
  expect(
    docLocalSqlViolation('orchestrator/src/doc/doc-read-store.ts', query, DOC_LOCAL_SQL_ALLOWANCES),
  ).toBeNull()
})
