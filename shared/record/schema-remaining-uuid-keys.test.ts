import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const migration = readFileSync(
  new URL('./migrations/20261025040554_dev_1726_uuid_primary_keys/migration.sql', import.meta.url),
  'utf8',
).replaceAll('--> statement-breakpoint', '')

const tables = [
  'board_message_tag',
  'board_receipt',
  'hub_change',
  'hub_change_head',
  'public_doc_space',
  'secret_dek_wrap',
  'seq',
  'machine_public_key',
  'question_mutation_audit',
] as const

test('remaining hosted tables mint UUID keys and preserve their old conflict keys', async () => {
  const database = new PGlite()
  await database.exec(`
    CREATE TABLE board_message_tag(
      message_id uuid NOT NULL, kind text NOT NULL, value text NOT NULL, origin text NOT NULL,
      CONSTRAINT board_message_tag_pkey PRIMARY KEY(message_id,kind,value,origin)
    );
    CREATE TABLE board_receipt(
      message_id uuid NOT NULL, reader_user_id uuid NOT NULL, reader_session text NOT NULL,
      CONSTRAINT board_receipt_pkey PRIMARY KEY(message_id,reader_user_id,reader_session)
    );
    CREATE TABLE hub_change(
      space_id uuid NOT NULL, sequence bigint NOT NULL,
      CONSTRAINT hub_change_pkey PRIMARY KEY(space_id,sequence)
    );
    CREATE TABLE hub_change_head(
      space_id uuid NOT NULL, CONSTRAINT hub_change_head_pkey PRIMARY KEY(space_id)
    );
    CREATE TABLE public_doc_space(
      space_id uuid NOT NULL, project_id uuid NOT NULL,
      CONSTRAINT public_doc_space_pkey PRIMARY KEY(space_id,project_id)
    );
    CREATE TABLE secret_dek_wrap(
      space_id uuid NOT NULL, dek_id uuid NOT NULL, recipient_key_id text NOT NULL,
      sender_key_id text NOT NULL,
      CONSTRAINT secret_dek_wrap_pkey
        PRIMARY KEY(space_id,dek_id,recipient_key_id,sender_key_id)
    );
    CREATE TABLE seq(
      space_id uuid NOT NULL, project_id uuid NOT NULL, name text NOT NULL,
      CONSTRAINT seq_pkey PRIMARY KEY(space_id,project_id,name)
    );
    CREATE TABLE machine_public_key(
      space_id uuid NOT NULL, key_id text NOT NULL,
      CONSTRAINT machine_public_key_space_key_unique UNIQUE(space_id,key_id)
    );
    CREATE TABLE question_mutation_audit(
      question_id uuid NOT NULL, action text NOT NULL, at timestamptz NOT NULL,
      CONSTRAINT question_mutation_audit_identity UNIQUE(question_id,action,at)
    );

    INSERT INTO board_message_tag VALUES
      ('01990000-0000-7000-8000-000000001001','task','DEV-1726','sender');
    INSERT INTO board_receipt VALUES
      ('01990000-0000-7000-8000-000000001001','01990000-0000-7000-8000-000000001002','session');
    INSERT INTO hub_change VALUES ('01990000-0000-7000-8000-000000001003',1);
    INSERT INTO hub_change_head VALUES ('01990000-0000-7000-8000-000000001003');
    INSERT INTO public_doc_space VALUES
      ('01990000-0000-7000-8000-000000001003','01990000-0000-7000-8000-000000001004');
    INSERT INTO secret_dek_wrap VALUES
      ('01990000-0000-7000-8000-000000001003','01990000-0000-7000-8000-000000001005','recipient','sender');
    INSERT INTO seq VALUES
      ('01990000-0000-7000-8000-000000001003','01990000-0000-7000-8000-000000001004','task:DEV');
    INSERT INTO machine_public_key VALUES
      ('01990000-0000-7000-8000-000000001003','machine-key');
    INSERT INTO question_mutation_audit VALUES
      ('01990000-0000-7000-8000-000000001006','answer','2026-10-25T00:00:00Z');
  `)

  const before = Object.fromEntries(
    await Promise.all(
      tables.map(async (table) => [
        table,
        (await database.query(`SELECT * FROM ${table}`)).rows.length,
      ]),
    ),
  )
  await database.exec(migration)
  const after = Object.fromEntries(
    await Promise.all(
      tables.map(async (table) => [
        table,
        (await database.query(`SELECT * FROM ${table}`)).rows.length,
      ]),
    ),
  )
  expect(after).toEqual(before)
  for (const table of tables) {
    const result = await database.query<{ id: string }>(`SELECT id::text FROM ${table}`)
    expect(result.rows[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  }

  const representativeDuplicates = [
    `INSERT INTO board_message_tag(message_id,kind,value,origin) VALUES
      ('01990000-0000-7000-8000-000000001001','task','DEV-1726','sender')`,
    `INSERT INTO hub_change_head(space_id) VALUES
      ('01990000-0000-7000-8000-000000001003')`,
    `INSERT INTO public_doc_space(space_id,project_id) VALUES
      ('01990000-0000-7000-8000-000000001003','01990000-0000-7000-8000-000000001004')`,
    `INSERT INTO machine_public_key(space_id,key_id) VALUES
      ('01990000-0000-7000-8000-000000001003','machine-key')`,
    `INSERT INTO seq(space_id,project_id,name) VALUES
      ('01990000-0000-7000-8000-000000001003','01990000-0000-7000-8000-000000001004','task:DEV')`,
    `INSERT INTO question_mutation_audit(question_id,action,at) VALUES
      ('01990000-0000-7000-8000-000000001006','answer','2026-10-25T00:00:00Z')`,
  ]
  for (const statement of representativeDuplicates) {
    await expect(database.exec(statement)).rejects.toThrow('duplicate key value')
  }
  await database.close()
})
