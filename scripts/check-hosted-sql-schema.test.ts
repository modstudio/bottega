import { describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { checkHostedSqlSchema } from './check-hosted-sql-schema.ts'
import { extractHostedSqlFromSource } from './hosted-sql-schema.ts'

describe('hosted SQL schema guard', () => {
  test('accepts a current column and rejects a wrong hosted column', async () => {
    const database = new PGlite()
    await database.waitReady
    await database.exec('CREATE TABLE run (id uuid PRIMARY KEY, number integer NOT NULL)')
    try {
      const correct = extractHostedSqlFromSource({
        sourceText:
          "import type { SQL } from 'bun'; async function read(sql: SQL) { return sql`SELECT id FROM run` }",
        file: 'correct.ts',
      })
      await expect(checkHostedSqlSchema({ database, ...correct })).resolves.toEqual({
        prepared: 1,
        skipped: 0,
      })

      const wrong = extractHostedSqlFromSource({
        sourceText:
          "import type { SQL } from 'bun'; async function read(sql: SQL) { return sql`SELECT record_id FROM run` }",
        file: 'wrong.ts',
      })
      await expect(checkHostedSqlSchema({ database, ...wrong })).rejects.toThrow(
        /column "record_id" does not exist/,
      )
    } finally {
      await database.close()
    }
  })
})
