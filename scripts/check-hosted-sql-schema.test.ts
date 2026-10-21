import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { checkHostedSqlSchema } from './check-hosted-sql-schema.ts'
import {
  extractHostedFixtureSqlFromSource,
  extractHostedSql,
  extractHostedSqlFromSource,
} from './hosted-sql-schema.ts'

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

  test('extracts each statement passed to a real-Postgres fixture executor', async () => {
    const database = new PGlite()
    await database.waitReady
    await database.exec('CREATE TABLE review_lens (id uuid PRIMARY KEY, review_id uuid NOT NULL)')
    try {
      const extracted = extractHostedFixtureSqlFromSource({
        sourceText: `
          succeeds('postgres', 'postgres', \`
            INSERT INTO review_lens (id, review_id) VALUES ('\${lens}', '\${review}');
            SELECT review_record_id FROM review_lens;
          \`)
        `,
        file: 'orchestrator/src/postgres/example.test.ts',
      })
      expect(extracted.sites).toHaveLength(2)
      await expect(checkHostedSqlSchema({ database, sites: extracted.sites })).rejects.toThrow(
        /column "review_record_id" does not exist/,
      )
    } finally {
      await database.close()
    }
  })

  for (const [name, sourceText] of [
    [
      'value-generator call',
      "succeeds('postgres', 'postgres', `SELECT wrong_id FROM run WHERE id='${newRecordId()}'`)",
    ],
    ['admin tagged template', 'admin`SELECT wrong_id FROM run WHERE id=${runId}`'],
    ['sql.unsafe call', "sql.unsafe(`SELECT wrong_id FROM run WHERE id='${runId}'`)"],
  ] as const) {
    test(`rejects a wrong hosted column in a ${name}`, async () => {
      const database = new PGlite()
      await database.waitReady
      await database.exec('CREATE TABLE run (id uuid PRIMARY KEY)')
      try {
        const extracted = extractHostedFixtureSqlFromSource({
          sourceText,
          file: `${name}.ts`,
        })
        expect(extracted.sites).toHaveLength(1)
        expect(extracted.unresolved).toHaveLength(0)
        await expect(checkHostedSqlSchema({ database, sites: extracted.sites })).rejects.toThrow(
          /column "wrong_id" does not exist/,
        )
      } finally {
        await database.close()
      }
    })
  }

  test('reports a structural interpolation instead of dropping its statement', () => {
    const extracted = extractHostedFixtureSqlFromSource({
      sourceText: 'admin(`INSERT INTO run (id) VALUES ${rowValues()}`)',
      file: 'structural.ts',
    })
    expect(extracted.sites).toHaveLength(0)
    expect(extracted.unresolved).toHaveLength(1)
    expect(extracted.unresolved[0]?.expression).toBe('rowValues()')
  })

  test('selects a fixture file even when its SQL executor is unsupported', () => {
    const extracted = extractHostedFixtureSqlFromSource({
      sourceText: 'unknownExecutor(`SELECT id FROM run`)',
      file: 'unsupported.ts',
    })
    expect(extracted.selected).toBe(true)
    expect(extracted.sites).toHaveLength(0)
    expect(extracted.unresolved).toHaveLength(0)
  })

  test('reports a projection interpolation instead of replacing the selected column', () => {
    const extracted = extractHostedFixtureSqlFromSource({
      sourceText: "asSpace(`SELECT ${expression} FROM run_score WHERE run_id='${recordId}'`)",
      file: 'projection.ts',
    })
    expect(extracted.sites).toHaveLength(0)
    expect(extracted.unresolved).toHaveLength(1)
    expect(extracted.unresolved[0]?.expression).toBe('expression')
  })

  test('extracts SQL passed through a local SET-plus-statement wrapper', () => {
    const extracted = extractHostedFixtureSqlFromSource({
      sourceText: `
        function actor(input: { psql: Function }, user: string, statement: string) {
          return input.psql('record_actor', 'password', \`SET app.user_id='\${user}'; \${statement}\`)
        }
        actor(input, userId, \`SELECT wrong_id FROM run WHERE id='\${runId}'\`)
      `,
      file: 'wrapper.ts',
    })
    expect(extracted.sites.map((site) => site.sql)).toContain(
      'SELECT wrong_id FROM run WHERE id=NULL',
    )
  })

  test('excludes a temporary table only within its statement batch', () => {
    const extracted = extractHostedFixtureSqlFromSource({
      sourceText: `
        psql('record_actor', 'password', \`
          CREATE TEMP TABLE board_message (id uuid);
          INSERT INTO board_message VALUES ('local');
          SELECT wrong_id FROM public.board_message;
        \`)
        admin(\`SELECT wrong_id FROM board_message\`)
      `,
      file: 'temporary.ts',
    })
    expect(extracted.sites.map((site) => site.sql)).toEqual([
      'SELECT wrong_id FROM public.board_message',
      'SELECT wrong_id FROM board_message',
    ])
  })

  test('covers SQL-bearing helpers in the real-Postgres import closure', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const extracted = extractHostedSql(root)
    expect(
      extracted.sites.some(
        (site) =>
          site.file === 'orchestrator/test/fixtures/record-auth-postgres.ts' &&
          site.sql.includes('FROM invitation'),
      ),
    ).toBe(true)
    expect(
      extracted.sites.some(
        (site) =>
          site.file === 'orchestrator/test/postgres-board-proof.ts' &&
          site.line === 372 &&
          site.sql.includes('FROM board_message'),
      ),
    ).toBe(true)
  })
})
