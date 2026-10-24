import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'

function leadingIndexColumns(database: Database, table: string): Set<string> {
  const indexes = database
    .query<{ name: string; partial: number }, [string]>(
      'SELECT name,partial FROM pragma_index_list(?)',
    )
    .all(table)
    .filter((index) => index.partial === 0)
  const leading = new Set(
    indexes.flatMap(({ name }) =>
      database
        .query<{ name: string }, [string]>('SELECT name FROM pragma_index_info(?) WHERE seqno = 0')
        .all(name)
        .map((row) => row.name),
    ),
  )
  const columns = database
    .query<{ name: string; type: string; pk: number }, [string]>(
      'SELECT name,type,pk FROM pragma_table_info(?)',
    )
    .all(table)
  const primaryKey = columns.filter((column) => column.pk > 0)
  const rowidAlias = primaryKey.length === 1 ? primaryKey[0] : undefined
  if (rowidAlias?.pk === 1 && rowidAlias.type.toUpperCase() === 'INTEGER') {
    leading.add(rowidAlias.name)
  }
  return leading
}

function unindexedForeignKeys(database: Database): string[] {
  const tables = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
  return tables.flatMap(({ name: table }) => {
    const indexed = leadingIndexColumns(database, table)
    return database
      .query<{ from: string }, [string]>('SELECT "from" FROM pragma_foreign_key_list(?)')
      .all(table)
      .filter((foreignKey) => !indexed.has(foreignKey.from))
      .map((foreignKey) => `${table}.${foreignKey.from}`)
  })
}

test('every declared orchestrator foreign key leads an index', () => {
  const database = new Database(':memory:')
  try {
    applyMigrations(database)
    expect(unindexedForeignKeys(database)).toEqual([])
  } finally {
    database.close()
  }
})
