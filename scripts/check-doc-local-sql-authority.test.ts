import { expect, test } from 'bun:test'
import { DOC_LOCAL_SQL_ALLOWANCES, docLocalSqlViolation } from './check-doc-local-sql-authority.ts'

const sources = [
  "import { db } from '../database/db.ts'; // receiver's name is irrelevant\ndb().query('SELECT * FROM doc WHERE slug=?')",
  "import { db } from '../database/db.ts'; const d = db(); d.query('SELECT * FROM doc WHERE slug=?')",
  "import { db } from '../database/db.ts'; db().prepare('SELECT * FROM doc WHERE slug=?')",
  "import type { Database } from 'bun:sqlite'; function f(store: Database) { return store.query('SELECT body FROM doc_revision').all() }",
  "import { db } from '../database/db.ts'; const SQL = 'SELECT * FROM doc'; db().query(SQL)",
]

test('document SQL outside the allow-list is refused independent of call shape', () => {
  for (const source of sources) {
    expect(docLocalSqlViolation('orchestrator/src/run/unsafe.ts', source)).toContain(
      'document-table SQL',
    )
  }
})

test('document SQL in an allow-listed local store is accepted', () => {
  expect(
    docLocalSqlViolation(
      'orchestrator/src/doc/doc-read-store.ts',
      sources[0]!,
      DOC_LOCAL_SQL_ALLOWANCES,
    ),
  ).toBeNull()
})
