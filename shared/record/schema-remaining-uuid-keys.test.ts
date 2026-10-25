import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'

const migrationsFolder = join(fileURLToPath(new URL('.', import.meta.url)), 'migrations')
const targetMigrationName = '20261025040554_dev_1726_uuid_primary_keys'
const migrations = readMigrationFiles({ migrationsFolder })
const targetMigration = migrations.find(({ name }) => name === targetMigrationName)
if (!targetMigration) throw new Error(`Missing migration ${targetMigrationName}`)

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

const formerPrimaryKeyColumns = {
  board_message_tag: ['message_id', 'kind', 'value', 'origin'],
  board_receipt: ['message_id', 'reader_user_id', 'reader_session'],
  hub_change: ['space_id', 'sequence'],
  hub_change_head: ['space_id'],
  public_doc_space: ['space_id', 'project_id'],
  secret_dek_wrap: ['space_id', 'dek_id', 'recipient_key_id', 'sender_key_id'],
  seq: ['space_id', 'project_id', 'name'],
} as const

async function applyMigration(transaction: Transaction, migration: MigrationMeta) {
  for (const statement of migration.sql) await transaction.exec(statement)
  await transaction.query(
    'INSERT INTO drizzle.__drizzle_migrations (hash,created_at,name) VALUES ($1,$2,$3)',
    [migration.hash, migration.folderMillis, migration.name],
  )
}

test('remaining hosted tables mint UUID keys and preserve their old conflict keys', async () => {
  const database = new PGlite()
  try {
    await database.exec(`
      CREATE ROLE record_owner LOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE record_actor LOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE record_auth LOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE record_public NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE record_reader LOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT record_public TO record_actor WITH INHERIT FALSE, SET TRUE;
      GRANT CREATE ON DATABASE postgres TO record_owner;
      ALTER SCHEMA public OWNER TO record_owner;
      SET ROLE record_owner;
      CREATE SCHEMA drizzle;
      CREATE TABLE drizzle.__drizzle_migrations (
        id serial PRIMARY KEY, hash text NOT NULL, created_at bigint, name text
      );
    `)
    await database.transaction(async (transaction) => {
      for (const migration of migrations) {
        if (migration.name === targetMigrationName) break
        await applyMigration(transaction, migration)
      }
    })

    await database.exec(`
      RESET ROLE;
      INSERT INTO space(id,name,slug,created_at) VALUES
        ('01990000-0000-7000-8000-000000001003','UUID migration','uuid-migration',now());
      INSERT INTO "user"(id,email,name,created_at) VALUES
        ('01990000-0000-7000-8000-000000001002','uuid-migration@example.test','UUID reader',now());
      INSERT INTO machine(id,user_id,name,registered_at,last_seen) VALUES
        ('01990000-0000-7000-8000-000000001007','01990000-0000-7000-8000-000000001002',
         'UUID machine',now(),now());
      INSERT INTO project(id,space_id,name,created_at) VALUES
        ('01990000-0000-7000-8000-000000001004','01990000-0000-7000-8000-000000001003',
         'uuid-project',now());
      INSERT INTO board_message(
        id,author_user_id,kind,audience,title,body,ack_required,expires_at,created_at
      ) VALUES (
        '01990000-0000-7000-8000-000000001001','01990000-0000-7000-8000-000000001002',
        'notice','users','UUID migration','fixture',false,now() + interval '1 day',now()
      );
      INSERT INTO secret_dek(id,space_id,version,created_at) VALUES
        ('01990000-0000-7000-8000-000000001005','01990000-0000-7000-8000-000000001003',1,now());
      INSERT INTO question(
        id,space_id,machine_id,revision,asked_at,question,withheld_fields,created_at,updated_at
      ) VALUES (
        '01990000-0000-7000-8000-000000001006','01990000-0000-7000-8000-000000001003',
        '01990000-0000-7000-8000-000000001007',1,now(),'Fixture?','[]'::jsonb,now(),now()
      );

      INSERT INTO board_message_tag(message_id,kind,value,origin) VALUES
        ('01990000-0000-7000-8000-000000001001','task','DEV-1726','sender');
      INSERT INTO board_receipt(message_id,reader_user_id,reader_session,audience_at_posting) VALUES
        ('01990000-0000-7000-8000-000000001001','01990000-0000-7000-8000-000000001002',
         'session',true);
      INSERT INTO hub_change(space_id,sequence,table_name,row_id,op,at) VALUES
        ('01990000-0000-7000-8000-000000001003',1,'hub_task',
         '01990000-0000-7000-8000-000000001008','upsert',now());
      INSERT INTO hub_change_head(space_id,sequence) VALUES
        ('01990000-0000-7000-8000-000000001003',1);
      INSERT INTO public_doc_space(space_id,project_id) VALUES
        ('01990000-0000-7000-8000-000000001003','01990000-0000-7000-8000-000000001004');
      INSERT INTO secret_dek_wrap(
        space_id,dek_id,recipient_key_id,sender_key_id,enc,ciphertext,created_at
      ) VALUES (
        '01990000-0000-7000-8000-000000001003','01990000-0000-7000-8000-000000001005',
        'AAAAAAAAAAAAAAAAAAAAAA','BBBBBBBBBBBBBBBBBBBBBB',decode('00','hex'),decode('01','hex'),now()
      );
      INSERT INTO seq(space_id,project_id,name,next) VALUES
        ('01990000-0000-7000-8000-000000001003','01990000-0000-7000-8000-000000001004',
         'task:DEV',1);
      INSERT INTO machine_public_key(space_id,key_id,public_key,label,created_at) VALUES
        ('01990000-0000-7000-8000-000000001003','CCCCCCCCCCCCCCCCCCCCCC',
         decode(repeat('00',32),'hex'),'fixture',now());
      INSERT INTO question_mutation_audit(question_id,space_id,action,at) VALUES
        ('01990000-0000-7000-8000-000000001006','01990000-0000-7000-8000-000000001003',
         'answer','2026-10-25T00:00:00Z');
    `)

    const before = Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [
          table,
          (await database.query(`SELECT * FROM ${table}`)).rows.length,
        ]),
      ),
    )
    await database.exec('SET ROLE record_owner')
    await database.transaction((transaction) => applyMigration(transaction, targetMigration))
    await database.exec('RESET ROLE')
    const after = Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [
          table,
          (await database.query(`SELECT * FROM ${table}`)).rows.length,
        ]),
      ),
    )
    expect(after).toEqual(before)

    const duplicates = [
      `INSERT INTO board_message_tag(message_id,kind,value,origin) VALUES
        ('01990000-0000-7000-8000-000000001001','task','DEV-1726','sender')`,
      `INSERT INTO board_receipt(message_id,reader_user_id,reader_session,audience_at_posting) VALUES
        ('01990000-0000-7000-8000-000000001001','01990000-0000-7000-8000-000000001002',
         'session',true)`,
      `INSERT INTO hub_change(space_id,sequence,table_name,row_id,op) VALUES
        ('01990000-0000-7000-8000-000000001003',1,'hub_task',
         '01990000-0000-7000-8000-000000001008','upsert')`,
      `INSERT INTO hub_change_head(space_id,sequence) VALUES
        ('01990000-0000-7000-8000-000000001003',1)`,
      `INSERT INTO public_doc_space(space_id,project_id) VALUES
        ('01990000-0000-7000-8000-000000001003','01990000-0000-7000-8000-000000001004')`,
      `INSERT INTO secret_dek_wrap(
         space_id,dek_id,recipient_key_id,sender_key_id,enc,ciphertext,created_at
       ) VALUES (
         '01990000-0000-7000-8000-000000001003','01990000-0000-7000-8000-000000001005',
         'AAAAAAAAAAAAAAAAAAAAAA','BBBBBBBBBBBBBBBBBBBBBB',decode('00','hex'),decode('01','hex'),now()
       )`,
      `INSERT INTO seq(space_id,project_id,name,next) VALUES
        ('01990000-0000-7000-8000-000000001003','01990000-0000-7000-8000-000000001004',
         'task:DEV',1)`,
      `INSERT INTO machine_public_key(space_id,key_id,public_key,label,created_at) VALUES
        ('01990000-0000-7000-8000-000000001003','CCCCCCCCCCCCCCCCCCCCCC',
         decode(repeat('00',32),'hex'),'fixture',now())`,
      `INSERT INTO question_mutation_audit(question_id,space_id,action,at) VALUES
        ('01990000-0000-7000-8000-000000001006','01990000-0000-7000-8000-000000001003',
         'answer','2026-10-25T00:00:00Z')`,
    ]
    for (const statement of duplicates) {
      await expect(database.exec(statement)).rejects.toThrow('duplicate key value')
    }

    for (const table of tables) {
      const primaryKeys = await database.query<{ oid: string }>(
        `SELECT constraint_row.oid::text
         FROM pg_constraint constraint_row
         JOIN pg_class table_row ON table_row.oid=constraint_row.conrelid
         JOIN pg_namespace namespace_row ON namespace_row.oid=table_row.relnamespace
         WHERE namespace_row.nspname='public' AND table_row.relname=$1
           AND constraint_row.contype='p'`,
        [table],
      )
      expect(primaryKeys.rows).toHaveLength(1)

      const columns = await database.query<{ column_name: string }>(
        `SELECT attribute_row.attname AS column_name
         FROM pg_constraint constraint_row
         JOIN unnest(constraint_row.conkey) WITH ORDINALITY
           AS key_column(attribute_number,position) ON true
         JOIN pg_attribute attribute_row
           ON attribute_row.attrelid=constraint_row.conrelid
          AND attribute_row.attnum=key_column.attribute_number
         WHERE constraint_row.oid=$1::oid
         ORDER BY key_column.position`,
        [primaryKeys.rows[0]!.oid],
      )
      expect(columns.rows).toEqual([{ column_name: 'id' }])
    }

    for (const [table, columns] of Object.entries(formerPrimaryKeyColumns)) {
      const result = await database.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name,is_nullable FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 AND column_name = ANY($2::text[])
         ORDER BY column_name`,
        [table, [...columns]],
      )
      expect(result.rows).toEqual(
        [...columns].sort().map((columnName) => ({ column_name: columnName, is_nullable: 'NO' })),
      )
    }
  } finally {
    await database.close()
  }
})
