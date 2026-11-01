import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { migrationSessionStatements } from '../../../shared/record/migration-session.ts'
import { PLATFORM_SPACE_ID, RECORD_OWNER_ROLE } from '../../../shared/record/schema.ts'

const ownerUrl = process.env.BOTTEGA_TEST_DOC_AUTHOR_MIGRATION_URL
const superuserUrl = process.env.BOTTEGA_TEST_DOC_AUTHOR_MIGRATION_SUPERUSER_URL
const realPostgres = ownerUrl && superuserUrl ? describe : describe.skip
const migrationsFolder = join(import.meta.dir, '..', '..', '..', 'shared', 'record', 'migrations')
const authorBackfill = '20261013015000_dev_1289_doc_revision_author_backfill'
let priorMigrations = ''

const STAND_IN_ID = '01990000-0000-7000-8000-000000000002'
const PERSON_ID = '01990000-0000-7000-8000-000000001289'
const SECOND_PERSON_ID = '01990000-0000-7000-8000-000000001290'
const DOC_ID = '01990000-0000-7000-8000-000000001291'

async function resetToBeforeBackfill(owner: SQL, superuser: SQL): Promise<void> {
  await superuser.unsafe(`
    DROP SCHEMA public CASCADE;
    DROP SCHEMA IF EXISTS drizzle CASCADE;
    CREATE SCHEMA public AUTHORIZATION ${RECORD_OWNER_ROLE};
  `)
  for (const statement of migrationSessionStatements()) await owner.unsafe(statement)
  await migrate(drizzle({ client: owner }), { migrationsFolder: priorMigrations })
}

async function seedPeople(superuser: SQL, people: readonly [string, string][]): Promise<void> {
  for (const [id, email] of people)
    await superuser`
      INSERT INTO "user" (id, email, name, created_at)
      VALUES (${id}, ${email}, 'Person', '2026-10-12T00:00:00Z')
    `
}

async function seedRevision(
  superuser: SQL,
  id: string,
  reason: string,
  author: string,
  sessionId: string,
  at: string,
): Promise<void> {
  await superuser`
    INSERT INTO doc_revision
      (id, space_id, doc_id, scope, subject, slug, op, title, body, delivery, audiences,
       author, reason, session_id, at)
    VALUES
      (${id}, ${PLATFORM_SPACE_ID}, ${DOC_ID}, 'global', NULL, 'author-backfill', 'set',
       'Author backfill', 'Body', 'demand', ARRAY['technical'], ${author}, ${reason}, ${sessionId},
       ${at})
  `
}

async function revisionAuthors(superuser: SQL): Promise<unknown[]> {
  return superuser.unsafe(
    'SELECT reason, author, session_id FROM doc_revision ORDER BY reason',
  ) as Promise<unknown[]>
}

realPostgres('populated hosted doc revision author backfill', () => {
  beforeAll(() => {
    priorMigrations = mkdtempSync(join(tmpdir(), 'dev-1289-prior-migrations-'))
    for (const folder of readdirSync(migrationsFolder).filter((name) => name < authorBackfill))
      cpSync(join(migrationsFolder, folder), join(priorMigrations, folder), { recursive: true })
  })

  afterAll(() => rmSync(priorMigrations, { recursive: true, force: true }))

  test('rewrites only eligible authors when exactly one non-stand-in person exists', async () => {
    const owner = new SQL({ url: ownerUrl!, max: 1 })
    const superuser = new SQL(superuserUrl!)
    try {
      await resetToBeforeBackfill(owner, superuser)
      await seedPeople(superuser, [[PERSON_ID, 'person@example.test']])
      const cases = [
        ['after cutoff', 'later-person', 'session-six', '2026-10-13T02:00:00Z', 'later-person'],
        ['already person', PERSON_ID, 'session-five', '2026-10-13T01:59:54Z', PERSON_ID],
        ['migration', 'migration', 'session-four', '2026-10-13T01:59:53Z', 'migration'],
        ['session author', 'session-1289', 'session-one', '2026-10-13T01:59:50Z', PERSON_ID],
        ['typed label', 'codex', 'session-three', '2026-10-13T01:59:52Z', PERSON_ID],
        ['unknown', 'unknown', 'session-two', '2026-10-13T01:59:51Z', PERSON_ID],
      ] as const
      for (const [index, [reason, author, sessionId, at]] of cases.entries())
        await seedRevision(
          superuser,
          `01990000-0000-7000-8000-${String(1292 + index).padStart(12, '0')}`,
          reason,
          author,
          sessionId,
          at,
        )

      for (const statement of migrationSessionStatements()) await owner.unsafe(statement)
      await migrate(drizzle({ client: owner }), { migrationsFolder })
      const expected = cases.map(([reason, , sessionId, , author]) => ({
        reason,
        author,
        session_id: sessionId,
      }))
      expect(await revisionAuthors(superuser)).toEqual(expected)
      const forced = await superuser.unsafe(`
        SELECT relforcerowsecurity AS forced
        FROM pg_class
        WHERE oid = 'public.doc_revision'::regclass
      `)
      expect(forced.map((row: { forced: boolean }) => row.forced)).toEqual([true])

      for (const statement of migrationSessionStatements()) await owner.unsafe(statement)
      await migrate(drizzle({ client: owner }), { migrationsFolder })
      expect(await revisionAuthors(superuser)).toEqual(expected)

      await resetToBeforeBackfill(owner, superuser)
      await seedRevision(
        superuser,
        '01990000-0000-7000-8000-000000001298',
        'stand-in only',
        'unknown',
        'session-stand-in',
        '2026-10-13T01:59:50Z',
      )
      for (const statement of migrationSessionStatements()) await owner.unsafe(statement)
      await migrate(drizzle({ client: owner }), { migrationsFolder })
      expect(await revisionAuthors(superuser)).toEqual([
        { reason: 'stand-in only', author: 'unknown', session_id: 'session-stand-in' },
      ])

      await resetToBeforeBackfill(owner, superuser)
      await seedPeople(superuser, [
        [PERSON_ID, 'person@example.test'],
        [SECOND_PERSON_ID, 'second-person@example.test'],
      ])
      await seedRevision(
        superuser,
        '01990000-0000-7000-8000-000000001299',
        'two people',
        'unknown',
        'session-two-people',
        '2026-10-13T01:59:50Z',
      )
      for (const statement of migrationSessionStatements()) await owner.unsafe(statement)
      await migrate(drizzle({ client: owner }), { migrationsFolder })
      expect(await revisionAuthors(superuser)).toEqual([
        { reason: 'two people', author: 'unknown', session_id: 'session-two-people' },
      ])

      const [standIn] = await superuser`SELECT id FROM "user" WHERE id = ${STAND_IN_ID}`
      expect(standIn).toEqual({ id: STAND_IN_ID })
    } finally {
      await owner.close()
      await superuser.close()
    }
  })
})
