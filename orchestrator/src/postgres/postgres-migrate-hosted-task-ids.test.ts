import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'

const migrationUrl = process.env.BOTTEGA_TEST_HOSTED_TASK_ID_MIGRATION_URL
const remainingUuidKeysMigrationUrl = process.env.BOTTEGA_TEST_REMAINING_UUID_KEYS_MIGRATION_URL
const realPostgres = migrationUrl ? describe : describe.skip
const migrationsFolder = join(import.meta.dir, '..', '..', '..', 'shared', 'record', 'migrations')
const taskIdBackfill = '20260924190350_dev_895_hosted_task_ids_backfill'
let priorMigrations = ''

const PARENT_ID = '01990000-0000-7000-8000-000000008950'
const TASK_ID = '01990000-0000-7000-8000-000000008951'
const COMMENT_ID = '01990000-0000-7000-8000-000000008952'
const DOCUMENT_ID = '01990000-0000-7000-8000-000000008953'
const STATUS_EVENT_ID = '01990000-0000-7000-8000-000000008954'
const NOTE_ID = '01990000-0000-7000-8000-000000008955'
const HUB_CHANGE_ROW_COUNT = 526_940
const HUB_CHANGE_MIGRATION_LIMIT_MS = 15_000

const remainingUuidMigration = readFileSync(
  new URL(
    '../../../shared/record/migrations/20261025040554_dev_1726_uuid_primary_keys/migration.sql',
    import.meta.url,
  ),
  'utf8',
)
const remainingUuidTables = [
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

realPostgres('populated hosted task id backfill', () => {
  beforeAll(async () => {
    priorMigrations = mkdtempSync(join(tmpdir(), 'dev-895-prior-migrations-'))
    for (const folder of readdirSync(migrationsFolder).filter((name) => name < taskIdBackfill)) {
      cpSync(join(migrationsFolder, folder), join(priorMigrations, folder), { recursive: true })
    }

    const sql = new SQL(migrationUrl!)
    try {
      await migrate(drizzle({ client: sql }), { migrationsFolder: priorMigrations })
      await sql.unsafe(`SET app.space_id = '${PLATFORM_SPACE_ID}'`)
      await sql`
        INSERT INTO hub_task
          (id, space_id, project_name, key, project, title, status, parent_key, source,
           first_seen, last_seen, created_at, updated_at)
        VALUES
          (${PARENT_ID}, ${PLATFORM_SPACE_ID}, ${PLATFORM_SLUG}, 'DEV-894', ${PLATFORM_SLUG},
           'Parent', 'open', NULL, 'local', now(), now(), now(), now()),
          (${TASK_ID}, ${PLATFORM_SPACE_ID}, ${PLATFORM_SLUG}, 'DEV-895', ${PLATFORM_SLUG},
           'Child', 'open', 'DEV-894', 'local', now(), now(), now(), now())
      `
      await sql`
        INSERT INTO hub_task_comment
          (id, space_id, project_name, task_key, body, created_at, updated_at)
        VALUES
          (${COMMENT_ID}, ${PLATFORM_SPACE_ID}, ${PLATFORM_SLUG}, 'DEV-895', 'Comment', now(), now())
      `
      await sql`
        INSERT INTO hub_task_document
          (id, space_id, project_name, task_key, title, body, version, created_at, updated_at)
        VALUES
          (${DOCUMENT_ID}, ${PLATFORM_SPACE_ID}, ${PLATFORM_SLUG}, 'DEV-895', 'Document', 'Body',
           '1', now(), now())
      `
      await sql`
        INSERT INTO hub_task_status_event
          (id, space_id, project_name, task_key, at, from_status, to_status, created_at, updated_at)
        VALUES
          (${STATUS_EVENT_ID}, ${PLATFORM_SPACE_ID}, ${PLATFORM_SLUG}, 'DEV-895', now(), 'todo',
           'open', now(), now())
      `
      await sql`
        INSERT INTO hub_note
          (id, space_id, project_name, number, project, text, anchors, sightings, created_at,
           last_seen_at, promoted_task, updated_at)
        VALUES
          (${NOTE_ID}, ${PLATFORM_SPACE_ID}, ${PLATFORM_SLUG}, 895, ${PLATFORM_SLUG}, 'Note', '', 1,
           now(), now(), 'DEV-895', now())
      `

      const forcedBefore = await sql`
        SELECT relname
        FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname IN (
            'hub_task', 'hub_task_comment', 'hub_task_document', 'hub_task_status_event', 'hub_note'
          )
          AND relforcerowsecurity
        ORDER BY relname
      `
      expect(forcedBefore.map((row: { relname: string }) => row.relname)).toEqual([
        'hub_note',
        'hub_task',
        'hub_task_comment',
        'hub_task_document',
        'hub_task_status_event',
      ])

      await sql.unsafe('RESET app.space_id')
      await migrate(drizzle({ client: sql }), { migrationsFolder })
    } finally {
      await sql.close()
    }
  })

  afterAll(() => rmSync(priorMigrations, { recursive: true, force: true }))

  test('backfills task ids as record_owner without an active space and restores FORCE RLS', async () => {
    const sql = new SQL(migrationUrl!)
    try {
      await sql.unsafe(`SET app.space_id = '${PLATFORM_SPACE_ID}'`)
      const [task] = await sql`
        SELECT parent_id FROM hub_task WHERE id = ${TASK_ID}
      `
      const [comment] = await sql`
        SELECT task_id FROM hub_task_comment WHERE id = ${COMMENT_ID}
      `
      const [document] = await sql`
        SELECT task_id FROM hub_task_document WHERE id = ${DOCUMENT_ID}
      `
      const [statusEvent] = await sql`
        SELECT task_id FROM hub_task_status_event WHERE id = ${STATUS_EVENT_ID}
      `
      const [note] = await sql`
        SELECT promoted_task_id FROM hub_note WHERE id = ${NOTE_ID}
      `
      expect(task?.parent_id).toBe(PARENT_ID)
      expect(comment?.task_id).toBe(TASK_ID)
      expect(document?.task_id).toBe(TASK_ID)
      expect(statusEvent?.task_id).toBe(TASK_ID)
      expect(note?.promoted_task_id).toBe(TASK_ID)

      const unforced = await sql`
        SELECT relname
        FROM pg_class
        WHERE relnamespace = 'public'::regnamespace
          AND relname IN (
            'hub_task', 'hub_task_comment', 'hub_task_document', 'hub_task_status_event', 'hub_note'
          )
          AND NOT relforcerowsecurity
        ORDER BY relname
      `
      expect(unforced).toEqual([])
    } finally {
      await sql.close()
    }
  })
})

const remainingUuidPostgres = remainingUuidKeysMigrationUrl ? test : test.skip

remainingUuidPostgres('remaining hosted UUID keys preserve every populated row', async () => {
  const sql = new SQL(remainingUuidKeysMigrationUrl!)
  const observer = new SQL(remainingUuidKeysMigrationUrl!)
  try {
    await sql.unsafe(`
      CREATE TABLE board_message_tag(
        message_id uuid NOT NULL, kind text NOT NULL, value text NOT NULL, origin text NOT NULL,
        CONSTRAINT board_message_tag_pkey PRIMARY KEY(message_id,kind,value,origin));
      CREATE TABLE board_receipt(
        message_id uuid NOT NULL, reader_user_id uuid NOT NULL, reader_session text NOT NULL,
        CONSTRAINT board_receipt_pkey PRIMARY KEY(message_id,reader_user_id,reader_session));
      CREATE TABLE hub_change(
        space_id uuid NOT NULL, sequence bigint NOT NULL, table_name text NOT NULL,
        row_id uuid NOT NULL, op text NOT NULL, at timestamptz,
        CONSTRAINT hub_change_pkey PRIMARY KEY(space_id,sequence));
      CREATE TABLE hub_change_head(space_id uuid NOT NULL,
        CONSTRAINT hub_change_head_pkey PRIMARY KEY(space_id));
      CREATE TABLE public_doc_space(space_id uuid NOT NULL, project_id uuid NOT NULL,
        CONSTRAINT public_doc_space_pkey PRIMARY KEY(space_id,project_id));
      CREATE TABLE secret_dek_wrap(
        space_id uuid NOT NULL, dek_id uuid NOT NULL, recipient_key_id text NOT NULL,
        sender_key_id text NOT NULL, CONSTRAINT secret_dek_wrap_pkey
        PRIMARY KEY(space_id,dek_id,recipient_key_id,sender_key_id));
      CREATE TABLE seq(space_id uuid NOT NULL, project_id uuid NOT NULL, name text NOT NULL,
        CONSTRAINT seq_pkey PRIMARY KEY(space_id,project_id,name));
      CREATE TABLE machine_public_key(space_id uuid NOT NULL, key_id text NOT NULL,
        CONSTRAINT machine_public_key_space_key_unique UNIQUE(space_id,key_id));
      CREATE TABLE question_mutation_audit(
        question_id uuid NOT NULL, action text NOT NULL, at timestamptz NOT NULL,
        CONSTRAINT question_mutation_audit_identity UNIQUE(question_id,action,at));
      INSERT INTO board_message_tag VALUES
        ('01990000-0000-7000-8000-000000001001','task','DEV-1726','sender');
      INSERT INTO board_receipt VALUES
        ('01990000-0000-7000-8000-000000001001','01990000-0000-7000-8000-000000001002','session');
      INSERT INTO hub_change(space_id, sequence, table_name, row_id, op, at)
      SELECT
        '01990000-0000-7000-8000-000000001003', sequence,
        CASE sequence % 4
          WHEN 0 THEN 'hub_report_subscription_recipient'
          WHEN 1 THEN 'project_lens_profile_revision'
          WHEN 2 THEN 'hub_report_subscription_project'
          ELSE 'hub_report_subscription_member'
        END,
        md5(sequence::text)::uuid,
        CASE sequence % 5 WHEN 0 THEN 'delete' ELSE 'upsert' END,
        '2026-10-25T00:00:00Z'::timestamptz - sequence * interval '1 millisecond'
      FROM generate_series(1, 526940) AS sequence;
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
    const [{ bytes: hubChangeBytes }] = await sql.unsafe(
      `SELECT pg_total_relation_size('hub_change')::bigint AS bytes`,
    )
    const hubChangeMebibytes = Number(hubChangeBytes) / 1024 / 1024
    expect(hubChangeMebibytes).toBeGreaterThanOrEqual(80)
    expect(hubChangeMebibytes).toBeLessThanOrEqual(100)
    const counts = async () => {
      const [row] = await sql.unsafe(`
        SELECT
          (SELECT count(*) FROM board_message_tag) AS board_message_tag,
          (SELECT count(*) FROM board_receipt) AS board_receipt,
          (SELECT count(*) FROM hub_change) AS hub_change,
          (SELECT count(*) FROM hub_change_head) AS hub_change_head,
          (SELECT count(*) FROM public_doc_space) AS public_doc_space,
          (SELECT count(*) FROM secret_dek_wrap) AS secret_dek_wrap,
          (SELECT count(*) FROM seq) AS seq,
          (SELECT count(*) FROM machine_public_key) AS machine_public_key,
          (SELECT count(*) FROM question_mutation_audit) AS question_mutation_audit
      `)
      return Object.fromEntries(
        remainingUuidTables.map((table) => [table, Number(row![table])]),
      )
    }
    const before = await counts()
    let hubChangeMigrationMilliseconds = 0
    let hubChangeLocks: string[] = []
    const migrationStartedAt = performance.now()
    await sql.begin(async (transaction) => {
      for (const source of remainingUuidMigration.split('--> statement-breakpoint')) {
        const statement = source.trim()
        if (!statement) continue
        const statementStartedAt = performance.now()
        await transaction.unsafe(statement)
        if (statement.includes('"hub_change"')) {
          hubChangeMigrationMilliseconds += performance.now() - statementStartedAt
        }
      }
      const [{ pid }] = await transaction.unsafe('SELECT pg_backend_pid() AS pid')
      hubChangeLocks = (
        await observer.unsafe(
          `SELECT DISTINCT mode
           FROM pg_locks
           WHERE pid = $1 AND relation = 'hub_change'::regclass AND granted
           ORDER BY mode`,
          [pid],
        )
      ).map((row: { mode: string }) => row.mode)
    })
    const migrationMilliseconds = performance.now() - migrationStartedAt
    console.log(
      `DEV-1726 populated migration: ${HUB_CHANGE_ROW_COUNT} hub_change rows, ` +
        `${hubChangeMebibytes.toFixed(1)} MiB; hub_change statements ` +
        `${hubChangeMigrationMilliseconds.toFixed(0)} ms; transaction ` +
        `${migrationMilliseconds.toFixed(0)} ms; locks ${hubChangeLocks.join(', ')}`,
    )
    expect(hubChangeMigrationMilliseconds).toBeLessThanOrEqual(HUB_CHANGE_MIGRATION_LIMIT_MS)
    expect(hubChangeLocks).toContain('AccessExclusiveLock')
    expect(before).toEqual({
      board_message_tag: 1,
      board_receipt: 1,
      hub_change: HUB_CHANGE_ROW_COUNT,
      hub_change_head: 1,
      public_doc_space: 1,
      secret_dek_wrap: 1,
      seq: 1,
      machine_public_key: 1,
      question_mutation_audit: 1,
    })
    expect(await counts()).toEqual(before)
  } finally {
    await observer.close()
    await sql.close()
  }
})
