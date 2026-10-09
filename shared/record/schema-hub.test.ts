import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { getTableColumns } from 'drizzle-orm'
import { hubSend, hubTaskComment, hubTaskDocument, hubTaskStatusEvent } from './schema-hub.ts'

const migration = (name: string) =>
  readFileSync(new URL(`./migrations/${name}/migration.sql`, import.meta.url), 'utf8').replaceAll(
    '--> statement-breakpoint',
    '',
  )

test('hosted task children and sends have no legacy local identity column', () => {
  for (const table of [hubTaskComment, hubTaskDocument, hubTaskStatusEvent, hubSend]) {
    expect(getTableColumns(table)).not.toHaveProperty('legacyLocalId')
  }
})

test('hosted document migration numbers live rows in UUID order and advances tasks', async () => {
  const database = new PGlite()
  await database.exec(`
    CREATE TABLE hub_task(id uuid PRIMARY KEY);
    CREATE TABLE hub_task_document(
      id uuid PRIMARY KEY,
      task_id uuid REFERENCES hub_task(id),
      created_at timestamptz NOT NULL,
      deleted_at timestamptz
    );
    INSERT INTO hub_task VALUES
      ('01990000-0000-7000-8000-000000000001'),
      ('01990000-0000-7000-8000-000000000002'),
      ('01990000-0000-7000-8000-000000000003');
    INSERT INTO hub_task_document VALUES
      ('01990000-0000-7000-8000-000000000102','01990000-0000-7000-8000-000000000001','2026-01-01',NULL),
      ('01990000-0000-7000-8000-000000000101','01990000-0000-7000-8000-000000000001','2026-01-01',NULL),
      ('01990000-0000-7000-8000-000000000103','01990000-0000-7000-8000-000000000001','2026-01-02',NULL),
      ('01990000-0000-7000-8000-000000000201','01990000-0000-7000-8000-000000000002','2026-01-01',NULL),
      ('01990000-0000-7000-8000-000000000202','01990000-0000-7000-8000-000000000002','2026-01-02','2026-01-03');
  `)
  await database.exec(
    migration('20261009011308_dev_1214_task_document_numbers_expand') +
      migration('20261009011309_dev_1214_task_document_numbers_backfill') +
      migration('20261009011320_dev_1214_task_document_numbers_contract'),
  )

  expect(
    (
      await database.query<{ id: string; number: number | null }>(
        `SELECT id::text,number FROM hub_task_document ORDER BY id`,
      )
    ).rows,
  ).toEqual([
    { id: '01990000-0000-7000-8000-000000000101', number: 1 },
    { id: '01990000-0000-7000-8000-000000000102', number: 2 },
    { id: '01990000-0000-7000-8000-000000000103', number: 3 },
    { id: '01990000-0000-7000-8000-000000000201', number: 1 },
    { id: '01990000-0000-7000-8000-000000000202', number: null },
  ])
  expect(
    (
      await database.query<{ next_document_number: number }>(
        `SELECT next_document_number FROM hub_task ORDER BY id`,
      )
    ).rows,
  ).toEqual([{ next_document_number: 4 }, { next_document_number: 2 }, { next_document_number: 1 }])

  await expect(
    database.exec(`
      INSERT INTO hub_task_document(id,task_id,created_at,deleted_at,number)
      VALUES (
        '01990000-0000-7000-8000-000000000104',
        '01990000-0000-7000-8000-000000000001',
        '2026-01-04',
        '2026-01-05',
        3
      );
    `),
  ).rejects.toThrow('hub_task_document_task_number_unique')
  await database.close()
})

test('hosted note migration scopes numbers and counters to each project', async () => {
  const database = new PGlite()
  await database.exec(`
    CREATE TABLE project(id uuid PRIMARY KEY, space_id uuid NOT NULL, name text NOT NULL);
    CREATE TABLE seq(
      space_id uuid NOT NULL,
      project_id uuid NOT NULL,
      name text NOT NULL,
      next bigint NOT NULL,
      PRIMARY KEY(space_id,project_id,name)
    );
    CREATE TABLE hub_note(
      id uuid PRIMARY KEY,
      space_id uuid NOT NULL,
      project_name text NOT NULL,
      number bigint NOT NULL,
      deleted_at timestamptz,
      CONSTRAINT hub_note_space_number_unique UNIQUE(space_id,number)
    );
    INSERT INTO project VALUES
      ('01990000-0000-7000-8000-000000000011','01990000-0000-7000-8000-000000000001','alpha'),
      ('01990000-0000-7000-8000-000000000012','01990000-0000-7000-8000-000000000001','beta'),
      ('01990000-0000-7000-8000-000000000013','01990000-0000-7000-8000-000000000001','empty');
    INSERT INTO seq VALUES
      ('01990000-0000-7000-8000-000000000001','01990000-0000-7000-8000-000000000011','note',2);
    INSERT INTO hub_note VALUES
      ('01990000-0000-7000-8000-000000000101','01990000-0000-7000-8000-000000000001','alpha',4,NULL),
      ('01990000-0000-7000-8000-000000000102','01990000-0000-7000-8000-000000000001','alpha',8,'2026-01-02'),
      ('01990000-0000-7000-8000-000000000201','01990000-0000-7000-8000-000000000001','beta',6,NULL);
  `)
  await database.exec(
    migration('20261009132504_dev_1212_project_note_numbers') +
      migration('20261009132726_dev_1212_project_note_counter_backfill'),
  )
  expect(
    (
      await database.query<{ name: string; next: number }>(
        `SELECT p.name,s.next::int FROM seq s JOIN project p ON p.id=s.project_id
         WHERE s.name='note' ORDER BY p.name`,
      )
    ).rows,
  ).toEqual([
    { name: 'alpha', next: 9 },
    { name: 'beta', next: 7 },
  ])
  await database.exec(`INSERT INTO hub_note VALUES
    ('01990000-0000-7000-8000-000000000202','01990000-0000-7000-8000-000000000001','beta',4,NULL)`)
  await expect(
    database.exec(`INSERT INTO hub_note VALUES
      ('01990000-0000-7000-8000-000000000103','01990000-0000-7000-8000-000000000001','alpha',4,NULL)`),
  ).rejects.toThrow('hub_note_space_project_number_unique')
  await database.close()
})
