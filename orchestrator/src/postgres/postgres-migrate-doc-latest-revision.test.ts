import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'

const ownerUrl = process.env.ORCH_TEST_DOC_REVISION_MIGRATION_URL
const superuserUrl = process.env.ORCH_TEST_DOC_REVISION_MIGRATION_SUPERUSER_URL
const realPostgres = ownerUrl && superuserUrl ? describe : describe.skip
const migrationsFolder = join(import.meta.dir, '..', '..', '..', 'shared', 'record', 'migrations')
const repairMigration = '20260924201224_dev_917_doc_latest_revision_repair'
let priorMigrations = ''

const SPACE_ID = '01990000-0000-7000-8000-000000009170'
const MISSING_DOC_ID = '01990000-0000-7000-8000-000000009171'
const MISSING_REVISION_ID = '01990000-0000-7000-8000-000000009172'
const SET_DOC_ID = '01990000-0000-7000-8000-000000009173'
const SET_REVISION_ID = '01990000-0000-7000-8000-000000009174'
const NEWER_REVISION_ID = '01990000-0000-7000-8000-000000009175'

realPostgres('hosted doc latest revision repair', () => {
  beforeAll(async () => {
    priorMigrations = mkdtempSync(join(tmpdir(), 'dev-917-prior-migrations-'))
    for (const folder of readdirSync(migrationsFolder).filter((name) => name < repairMigration)) {
      cpSync(join(migrationsFolder, folder), join(priorMigrations, folder), { recursive: true })
    }

    const owner = new SQL(ownerUrl!)
    const superuser = new SQL(superuserUrl!)
    try {
      await migrate(drizzle({ client: owner }), { migrationsFolder: priorMigrations })
      await superuser.unsafe(`
        INSERT INTO space (id, name, slug, created_at)
        VALUES ('${SPACE_ID}', 'doc repair', 'doc-repair', now());
        INSERT INTO doc
          (id, space_id, scope, subject, slug, title, body, delivery, created_at, updated_at,
           latest_revision_id)
        VALUES
          ('${MISSING_DOC_ID}', '${SPACE_ID}', 'machine', NULL, 'missing', 'Missing', 'body',
           'inject', now(), now(), NULL),
          ('${SET_DOC_ID}', '${SPACE_ID}', 'machine', NULL, 'set', 'Set', 'body',
           'inject', now(), now(), '${SET_REVISION_ID}');
        INSERT INTO doc_revision
          (id, space_id, doc_id, scope, subject, slug, op, title, body, delivery, author, reason, at)
        VALUES
          ('${MISSING_REVISION_ID}', '${SPACE_ID}', '${MISSING_DOC_ID}', 'machine', NULL, 'missing',
           'create', 'Missing', 'body', 'inject', 'proof', 'seed missing pointer', now()),
          ('${SET_REVISION_ID}', '${SPACE_ID}', '${SET_DOC_ID}', 'machine', NULL, 'set',
           'create', 'Set', 'body', 'inject', 'proof', 'seed existing pointer', now() - interval '1 minute'),
          ('${NEWER_REVISION_ID}', '${SPACE_ID}', '${SET_DOC_ID}', 'machine', NULL, 'set',
           'set', 'Set', 'newer', 'inject', 'proof', 'prove pointer is untouched', now());
      `)
      await migrate(drizzle({ client: owner }), { migrationsFolder })
    } finally {
      await owner.close()
      await superuser.close()
    }
  })

  afterAll(() => rmSync(priorMigrations, { recursive: true, force: true }))

  test('fills a null pointer and leaves an existing pointer untouched', async () => {
    const superuser = new SQL(superuserUrl!)
    try {
      const rows = await superuser.unsafe(
        `SELECT id, latest_revision_id FROM doc
         WHERE id IN ('${MISSING_DOC_ID}', '${SET_DOC_ID}') ORDER BY id`,
      )
      expect(rows).toEqual([
        { id: MISSING_DOC_ID, latest_revision_id: MISSING_REVISION_ID },
        { id: SET_DOC_ID, latest_revision_id: SET_REVISION_ID },
      ])

      const forced = await superuser.unsafe(`
        SELECT relname FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname IN ('doc', 'doc_revision')
          AND relforcerowsecurity
        ORDER BY relname
      `)
      expect(forced.map((row: { relname: string }) => row.relname)).toEqual(['doc', 'doc_revision'])
    } finally {
      await superuser.close()
    }
  })
})
