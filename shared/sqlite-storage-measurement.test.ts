import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { measureSqliteTables } from './sqlite-storage-measurement.ts'

test('SQLite table bytes include the pages owned by its indexes', () => {
  const database = new Database(':memory:')
  database.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
  database.exec('CREATE INDEX item_value_idx ON item(value)')
  database.exec("INSERT INTO item(value) VALUES ('one'), ('two')")
  const pages = database
    .query<{ name: string; bytes: number }, []>(
      "SELECT name, sum(pgsize) AS bytes FROM dbstat WHERE name IN ('item', 'item_value_idx') GROUP BY name",
    )
    .all()
  const expected = pages.reduce((sum, page) => sum + Number(page.bytes), 0)
  expect(measureSqliteTables(database, 'hub').find((table) => table.table === 'item')).toEqual({
    store: 'hub',
    table: 'item',
    bytes: expected,
    rows: 2,
  })
  database.close()
})
