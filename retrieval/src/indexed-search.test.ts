import { expect, test } from 'bun:test'
import { isReadOnlyIndexError } from './indexed-search.ts'

test('classifies SQLite read-only errors and permission errors on index files', () => {
  const databasePath = '/state/retrieval.db'

  expect(isReadOnlyIndexError({ code: 'SQLITE_READONLY' }, databasePath)).toBe(true)
  expect(isReadOnlyIndexError({ code: 'SQLITE_READONLY_DBMOVED' }, databasePath)).toBe(true)
  expect(isReadOnlyIndexError({ code: 'EACCES', path: `${databasePath}-wal` }, databasePath)).toBe(
    true,
  )
  expect(
    isReadOnlyIndexError({ code: 'EPERM', path: `${databasePath}-journal` }, databasePath),
  ).toBe(true)
  expect(isReadOnlyIndexError({ code: 'EACCES', path: '/other/file' }, databasePath)).toBe(false)
  expect(isReadOnlyIndexError({ code: 'SQLITE_BUSY' }, databasePath)).toBe(false)
})
