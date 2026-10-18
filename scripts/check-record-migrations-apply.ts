#!/usr/bin/env bun
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite, type Transaction } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator'
import { BOARD_MESSAGE_NOTIFY_CHANNEL } from '../orchestrator/src/record/record-board-stream.ts'
import { managedCanonProjectNames } from '../orchestrator/src/record/record-canon-facts.ts'
import {
  PLATFORM_SPACE_ID,
  RECORD_ACTOR_ROLE,
  RECORD_AUTH_ROLE,
  RECORD_OWNER_ROLE,
  RECORD_PUBLIC_ROLE,
  RECORD_READER_ROLE,
} from '../shared/record/schema.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const migrationsFolder = join(root, 'shared', 'record', 'migrations')
const rerun = 'bun scripts/check-record-migrations-apply.ts'
const brokenDocBackfill = '20260924180716_dev_906_doc_latest_revision'
const repairedDocBackfill = '20260924201224_dev_917_doc_latest_revision_repair'
const audienceSetBackfill = '20261009160001_dev_1238_doc_audiences_backfill'
const audienceVocabularyBackfill = '20261009210001_dev_1238_doc_audience_vocabulary_backfill'
const boardSharedSpacesMigration = '20261012210147_dev_1217_board_shared_spaces'
const boardNotifyMigration = '20261013170000_dev_1217_board_notify'
const boardPurposeBackfillMigration = '20261013225840_dev_1217_board_purpose_backfill'
const docJsonbArrayRepair = '20261013190000_dev_1303_doc_jsonb_array_repair'
const hubProjectIdentityExpand = '20261015133608_dev_1214_hub_project_identity'
const hubProjectIdentityBackfill = '20261015133609_dev_1214_hub_project_identity_backfill'
const proofDocId = '01990000-0000-7000-8000-000000000010'
const proofRevisionId = '01990000-0000-7000-8000-000000000012'
const managedProjectId = '01990000-0000-7000-8000-000000000013'
const unmanagedProjectId = '01990000-0000-7000-8000-000000000014'
const platformOperatorId = '01990000-0000-7000-8000-000000000002'
const publicAudienceProjectId = '01990000-0000-7000-8000-000000000015'
const internalAudienceProjectId = '01990000-0000-7000-8000-000000000016'
const publicAudienceDocId = '01990000-0000-7000-8000-000000000017'
const internalAudienceDocId = '01990000-0000-7000-8000-000000000018'
const boardBackfillRootId = '01990000-0000-7000-8000-000000000021'
const boardBackfillReplyId = '01990000-0000-7000-8000-000000000022'
const boardBackfillReplyAuthorId = '01990000-0000-7000-8000-000000000023'
const boardBackfillQuestionId = '01990000-0000-7000-8000-000000000027'
const jsonbStringDocId = '01990000-0000-7000-8000-000000000025'
const jsonbArrayDocId = '01990000-0000-7000-8000-000000000026'
const jsonbInvalidDocId = '01990000-0000-7000-8000-000000000027'
const hubProjectMatchId = '01990000-0000-7000-8000-000000000050'
const hubProjectMatchTaskId = '01990000-0000-7000-8000-000000000051'
const hubProjectUnmatchedTaskId = '01990000-0000-7000-8000-000000000052'
const crossSpaceProofSpaceId = '01990000-0000-7000-8000-000000000060'
const crossSpaceProofUserId = '01990000-0000-7000-8000-000000000061'
const sameSpaceSourceProjectId = '01990000-0000-7000-8000-000000000062'
const sameSpaceTargetProjectId = '01990000-0000-7000-8000-000000000063'
const otherSpaceProjectId = '01990000-0000-7000-8000-000000000064'
const sameSpacePairId = '01990000-0000-7000-8000-000000000065'
const crossSpacePairId = '01990000-0000-7000-8000-000000000066'

class CheckFailure extends Error {}

function firstLine(sql: string): string {
  return (
    sql
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? '<empty chunk>'
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function phaseFailure(phase: string, error: unknown): CheckFailure {
  return new CheckFailure(
    `${phase} failed: ${errorMessage(error)}. Check that @electric-sql/pglite is installed (bun install) and the migrations folder is readable, then rerun ${rerun}.`,
  )
}

function migrationFailure(
  migration: MigrationMeta,
  statement: string,
  error: unknown,
): CheckFailure {
  return new CheckFailure(
    `shared/record/migrations/${migration.name}/migration.sql failed at ${JSON.stringify(firstLine(statement))}: ${errorMessage(error)}. Fix that migration (never edit a generated one; regenerate it or add a custom one per .agents/contexts/orchestrator-record.md), then rerun ${rerun}.`,
  )
}

async function provision(database: PGlite): Promise<void> {
  await database.exec(`
    CREATE ROLE ${RECORD_OWNER_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE ${RECORD_ACTOR_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE ${RECORD_AUTH_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE ${RECORD_PUBLIC_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE ${RECORD_READER_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT ${RECORD_PUBLIC_ROLE} TO ${RECORD_ACTOR_ROLE} WITH INHERIT FALSE, SET TRUE;
    GRANT CREATE ON DATABASE postgres TO ${RECORD_OWNER_ROLE};
    ALTER SCHEMA public OWNER TO ${RECORD_OWNER_ROLE};
    SET ROLE ${RECORD_OWNER_ROLE};
    CREATE SCHEMA drizzle;
    CREATE TABLE drizzle.__drizzle_migrations (
      id serial PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint,
      name text,
      applied_at timestamp with time zone DEFAULT now()
    );
  `)
}

async function applyMigration(transaction: Transaction, migration: MigrationMeta): Promise<void> {
  for (const chunk of migration.sql) {
    try {
      await transaction.exec(chunk)
    } catch (error) {
      throw migrationFailure(migration, chunk, error)
    }
  }
  const journalInsert =
    'INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name) VALUES ($1, $2, $3)'
  try {
    await transaction.query(journalInsert, [migration.hash, migration.folderMillis, migration.name])
  } catch (error) {
    throw migrationFailure(migration, journalInsert, error)
  }
}

async function seedDocBackfillProof(transaction: Transaction): Promise<void> {
  await transaction.exec(`
    SELECT set_config('app.space_id', '01990000-0000-7000-8000-000000000001', true);
    INSERT INTO doc (id, space_id, scope, subject, slug, title, body, delivery, created_at, updated_at)
    VALUES (
      '${proofDocId}', '01990000-0000-7000-8000-000000000001', 'global', NULL,
      'migration-proof', 'Migration proof', 'body', 'demand',
      '2026-09-24T19:00:00Z', '2026-09-24T19:00:00Z'
    );
    INSERT INTO doc_revision (
      id, space_id, doc_id, scope, subject, slug, op, title, body, delivery,
      author, reason, at
    ) VALUES
      (
        '01990000-0000-7000-8000-000000000011',
        '01990000-0000-7000-8000-000000000001', '${proofDocId}', 'global', NULL,
        'migration-proof', 'create', 'Migration proof', 'body', 'demand',
        'migration-check', 'prove latest revision backfill', '2026-09-24T19:00:00Z'
      ),
      (
        '${proofRevisionId}', '01990000-0000-7000-8000-000000000001',
        '${proofDocId}', 'global', NULL, 'migration-proof', 'set', 'Migration proof',
        'new body', 'demand', 'migration-check', 'prove latest revision backfill',
        '2026-09-24T19:00:00Z'
      );
    SELECT set_config('app.space_id', '', true);
  `)
}

async function proofLatestRevision(transaction: Transaction): Promise<string | null> {
  await transaction.exec(
    `SELECT set_config('app.space_id', '01990000-0000-7000-8000-000000000001', true);`,
  )
  const result = await transaction.query<{ latest_revision_id: string | null }>(
    'SELECT latest_revision_id FROM doc WHERE id = $1',
    [proofDocId],
  )
  await transaction.exec(`SELECT set_config('app.space_id', '', true);`)
  if (result.rows.length !== 1) throw new CheckFailure('doc backfill proof row is not visible')
  return result.rows[0]?.latest_revision_id ?? null
}

async function proofAudienceBackfill(transaction: Transaction): Promise<void> {
  await transaction.exec(
    `SELECT set_config('app.space_id', '01990000-0000-7000-8000-000000000001', true);`,
  )
  const docs = await transaction.query<{ total: number; invalid: number }>(
    'SELECT count(*)::int AS total, count(*) FILTER (WHERE audiences IS DISTINCT FROM ARRAY[audience])::int AS invalid FROM doc',
  )
  const revisions = await transaction.query<{ total: number; invalid: number }>(
    'SELECT count(*)::int AS total, count(*) FILTER (WHERE audiences IS DISTINCT FROM ARRAY[audience])::int AS invalid FROM doc_revision',
  )
  await transaction.exec(`SELECT set_config('app.space_id', '', true);`)
  if (docs.rows[0]?.total === 0 || revisions.rows[0]?.total === 0) {
    throw new CheckFailure('DEV-1238 audience backfill proof rows are not visible')
  }
  if (docs.rows[0]?.invalid !== 0 || revisions.rows[0]?.invalid !== 0) {
    throw new CheckFailure('DEV-1238 audience backfill did not produce singleton sets')
  }
}

async function seedAudienceVocabularyBackfill(transaction: Transaction): Promise<void> {
  await transaction.exec(`
    SELECT set_config('app.space_id', '${PLATFORM_SPACE_ID}', true);
    SELECT set_config('app.user_id', '${platformOperatorId}', true);
    INSERT INTO project (id, space_id, name, created_at) VALUES
      ('${publicAudienceProjectId}', '${PLATFORM_SPACE_ID}', 'public-audience-proof', now()),
      ('${internalAudienceProjectId}', '${PLATFORM_SPACE_ID}', 'internal-audience-proof', now());
    INSERT INTO public_doc_space (space_id, project_id)
    VALUES ('${PLATFORM_SPACE_ID}', '${publicAudienceProjectId}');
    INSERT INTO doc
      (id, space_id, scope, subject, slug, title, body, delivery, audiences, project_id,
       created_at, updated_at)
    VALUES
      ('${publicAudienceDocId}', '${PLATFORM_SPACE_ID}', 'project', 'public-audience-proof',
       'public-audience-proof', 'Public audience proof', 'body', 'demand',
       ARRAY['technical','user'], '${publicAudienceProjectId}', now(), now()),
      ('${internalAudienceDocId}', '${PLATFORM_SPACE_ID}', 'project', 'internal-audience-proof',
       'internal-audience-proof', 'Internal audience proof', 'body', 'demand',
       ARRAY['user','technical','internal'], '${internalAudienceProjectId}', now(), now());
    INSERT INTO doc_revision
      (id, space_id, doc_id, scope, subject, slug, project_id, op, title, body, delivery,
       audiences, author, reason, at)
    VALUES
      ('01990000-0000-7000-8000-000000000019', '${PLATFORM_SPACE_ID}',
       '${publicAudienceDocId}', 'project', 'public-audience-proof', 'public-audience-proof',
       '${publicAudienceProjectId}', 'create', 'Public audience proof', 'body', 'demand',
       ARRAY['technical','user'], 'migration-check', 'prove public audience backfill', now()),
      ('01990000-0000-7000-8000-000000000020', '${PLATFORM_SPACE_ID}',
       '${internalAudienceDocId}', 'project', 'internal-audience-proof', 'internal-audience-proof',
       '${internalAudienceProjectId}', 'create', 'Internal audience proof', 'body', 'demand',
       ARRAY['user','technical','internal'], 'migration-check', 'prove internal audience backfill', now());
    SELECT set_config('app.space_id', '', true);
    SELECT set_config('app.user_id', '', true);
  `)
}

async function proofAudienceVocabularyBackfill(transaction: Transaction): Promise<void> {
  await transaction.exec(`
    SELECT set_config('app.space_id', '${PLATFORM_SPACE_ID}', true);
    SELECT set_config('app.user_id', '${platformOperatorId}', true);
  `)
  const docs = await transaction.query<{ id: string; audiences: string[] }>(
    'SELECT id, audiences FROM doc WHERE id IN ($1, $2) ORDER BY id',
    [publicAudienceDocId, internalAudienceDocId],
  )
  const revisions = await transaction.query<{ doc_id: string; audiences: string[] }>(
    'SELECT doc_id, audiences FROM doc_revision WHERE doc_id IN ($1, $2) ORDER BY doc_id',
    [publicAudienceDocId, internalAudienceDocId],
  )
  await transaction.exec(`
    SELECT set_config('app.space_id', '', true);
    SELECT set_config('app.user_id', '', true);
  `)
  const expected = [
    { id: publicAudienceDocId, audiences: ['technical', 'customer'] },
    { id: internalAudienceDocId, audiences: ['internal', 'technical'] },
  ].sort((left, right) => left.id.localeCompare(right.id))
  if (JSON.stringify(docs.rows) !== JSON.stringify(expected)) {
    throw new CheckFailure(
      `DEV-1238 document audience vocabulary backfill produced ${JSON.stringify(docs.rows)}`,
    )
  }
  const expectedRevisions = expected.map(({ id, audiences }) => ({ doc_id: id, audiences }))
  if (JSON.stringify(revisions.rows) !== JSON.stringify(expectedRevisions)) {
    throw new CheckFailure(
      `DEV-1238 revision audience vocabulary backfill produced ${JSON.stringify(revisions.rows)}`,
    )
  }
}

async function seedBoardThreadAuthorBackfill(transaction: Transaction): Promise<void> {
  await transaction.exec(`
    INSERT INTO "user" (id, email, name, created_at) VALUES
      ('${boardBackfillReplyAuthorId}', 'board-backfill-reply@example.test',
       'Board backfill reply author', now());
    ALTER TABLE board_message NO FORCE ROW LEVEL SECURITY;
    INSERT INTO board_message
      (id, author_user_id, kind, audience, title, body, ack_required, expires_at, created_at)
    VALUES
      ('${boardBackfillRootId}', '${platformOperatorId}', 'notice', 'operator',
       'Board backfill root', 'root', false, now() + interval '1 day', now());
    INSERT INTO board_message
      (id, author_user_id, kind, audience, title, body, ack_required, expires_at, created_at)
    VALUES
      ('${boardBackfillQuestionId}', '${platformOperatorId}', 'question', 'operator',
       'Board backfill question', 'question', false, now() + interval '1 day', now());
    INSERT INTO board_message
      (id, author_user_id, kind, thread_root_id, body, ack_required, created_at)
    VALUES
      ('${boardBackfillReplyId}', '${boardBackfillReplyAuthorId}', 'reply',
       '${boardBackfillRootId}', 'reply', false, now());
    ALTER TABLE board_message FORCE ROW LEVEL SECURITY;
  `)
}

async function proofBoardPurposeBackfill(transaction: Transaction): Promise<void> {
  await transaction.exec('ALTER TABLE board_message NO FORCE ROW LEVEL SECURITY;')
  const result = await transaction.query<{ kind: string; purpose: string | null }>(`
    SELECT kind,purpose FROM board_message
    WHERE id IN ('${boardBackfillRootId}','${boardBackfillQuestionId}','${boardBackfillReplyId}')
    ORDER BY kind
  `)
  await transaction.exec('ALTER TABLE board_message FORCE ROW LEVEL SECURITY;')
  const expected = [
    { kind: 'notice', purpose: 'information' },
    { kind: 'question', purpose: 'request' },
    { kind: 'reply', purpose: null },
  ]
  if (JSON.stringify(result.rows) !== JSON.stringify(expected)) {
    throw new CheckFailure(
      `DEV-1217 board purpose backfill produced ${JSON.stringify(result.rows)}`,
    )
  }
}

async function proofBoardThreadAuthorBackfill(transaction: Transaction): Promise<void> {
  await transaction.exec('ALTER TABLE board_message NO FORCE ROW LEVEL SECURITY;')
  const result = await transaction.query<{ invalid: number }>(`
    SELECT count(*)::int AS invalid
    FROM board_message AS reply
    LEFT JOIN board_message AS root ON root.id = reply.thread_root_id
    WHERE reply.kind = 'reply'
      AND reply.thread_root_author_user_id IS DISTINCT FROM root.author_user_id
  `)
  await transaction.exec('ALTER TABLE board_message FORCE ROW LEVEL SECURITY;')
  if (result.rows[0]?.invalid !== 0) {
    throw new CheckFailure('DEV-1217 board reply anchors do not match their root authors')
  }
}

async function seedDocJsonbArrayRepair(transaction: Transaction): Promise<void> {
  await transaction.exec(`
    SELECT set_config('app.space_id', '${PLATFORM_SPACE_ID}', true);
    SELECT set_config('app.user_id', '${platformOperatorId}', true);
    INSERT INTO doc
      (id,space_id,scope,subject,slug,title,body,delivery,audiences,source_files,created_at,updated_at)
    VALUES
      ('${jsonbStringDocId}','${PLATFORM_SPACE_ID}','global',NULL,'jsonb-string','String','body','demand',ARRAY['technical'],to_jsonb('["src/string.ts"]'::text),'2026-10-13T12:00:00Z','2026-10-13T12:00:00Z'),
      ('${jsonbArrayDocId}','${PLATFORM_SPACE_ID}','global',NULL,'jsonb-array','Array','body','demand',ARRAY['technical'],'["src/array.ts"]'::jsonb,'2026-10-13T12:00:00Z','2026-10-13T12:00:00Z'),
      ('${jsonbInvalidDocId}','${PLATFORM_SPACE_ID}','global',NULL,'jsonb-invalid','Invalid','body','demand',ARRAY['technical'],to_jsonb('not an array'::text),'2026-10-13T12:00:00Z','2026-10-13T12:00:00Z');
    INSERT INTO doc_revision
      (id,space_id,doc_id,scope,subject,slug,op,title,body,delivery,audiences,related_subject_ids,source_files,author,reason,at)
    VALUES
      ('01990000-0000-7000-8000-000000000028','${PLATFORM_SPACE_ID}','${jsonbStringDocId}','global',NULL,'jsonb-string','create','String','body','demand',ARRAY['technical'],to_jsonb('["01990000-0000-7000-8000-000000000029"]'::text),to_jsonb('["src/string.ts"]'::text),'proof','repair string','2026-10-13T12:00:00Z'),
      ('01990000-0000-7000-8000-000000000030','${PLATFORM_SPACE_ID}','${jsonbArrayDocId}','global',NULL,'jsonb-array','create','Array','body','demand',ARRAY['technical'],'[]'::jsonb,'["src/array.ts"]'::jsonb,'proof','leave array','2026-10-13T12:00:00Z'),
      ('01990000-0000-7000-8000-000000000031','${PLATFORM_SPACE_ID}','${jsonbInvalidDocId}','global',NULL,'jsonb-invalid','create','Invalid','body','demand',ARRAY['technical'],to_jsonb('not an array'::text),to_jsonb('not an array'::text),'proof','leave invalid','2026-10-13T12:00:00Z');
    SELECT set_config('app.space_id', '', true);
    SELECT set_config('app.user_id', '', true);
  `)
}

async function proofDocJsonbArrayRepair(transaction: Transaction): Promise<void> {
  await transaction.exec(`
    SELECT set_config('app.space_id', '${PLATFORM_SPACE_ID}', true);
    SELECT set_config('app.user_id', '${platformOperatorId}', true);
  `)
  const docs = await transaction.query<{
    id: string
    source_type: string
    source_files: unknown
    advanced: boolean
  }>(`
    SELECT id,jsonb_typeof(source_files) AS source_type,source_files,
      updated_at > '2026-10-13T12:00:00Z'::timestamptz AS advanced
    FROM doc WHERE id IN ('${jsonbStringDocId}','${jsonbArrayDocId}','${jsonbInvalidDocId}')
    ORDER BY id
  `)
  const revisions = await transaction.query<{
    doc_id: string
    related_type: string
    source_type: string
  }>(`
    SELECT doc_id,jsonb_typeof(related_subject_ids) AS related_type,
      jsonb_typeof(source_files) AS source_type
    FROM doc_revision
    WHERE doc_id IN ('${jsonbStringDocId}','${jsonbArrayDocId}','${jsonbInvalidDocId}')
    ORDER BY doc_id
  `)
  const expectedDocs = [
    { id: jsonbStringDocId, source_type: 'array', source_files: ['src/string.ts'], advanced: true },
    { id: jsonbArrayDocId, source_type: 'array', source_files: ['src/array.ts'], advanced: false },
    { id: jsonbInvalidDocId, source_type: 'string', source_files: 'not an array', advanced: false },
  ]
  if (JSON.stringify(docs.rows) !== JSON.stringify(expectedDocs))
    throw new CheckFailure(`DEV-1303 document repair produced ${JSON.stringify(docs.rows)}`)
  const expectedRevisions = [
    { doc_id: jsonbStringDocId, related_type: 'array', source_type: 'array' },
    { doc_id: jsonbArrayDocId, related_type: 'array', source_type: 'array' },
    { doc_id: jsonbInvalidDocId, related_type: 'string', source_type: 'string' },
  ]
  if (JSON.stringify(revisions.rows) !== JSON.stringify(expectedRevisions))
    throw new CheckFailure(`DEV-1303 revision repair produced ${JSON.stringify(revisions.rows)}`)
  const forced = await transaction.query<{ relname: string }>(`
    SELECT relname FROM pg_class
    WHERE relnamespace='public'::regnamespace
      AND relname IN ('doc','doc_revision') AND relforcerowsecurity
    ORDER BY relname
  `)
  if (JSON.stringify(forced.rows.map((row) => row.relname)) !== '["doc","doc_revision"]')
    throw new CheckFailure('DEV-1303 document repair did not restore forced row-level security')
  await transaction.exec(`
    SELECT set_config('app.space_id', '', true);
    SELECT set_config('app.user_id', '', true);
  `)
}

function sqlTag(transaction: Transaction): SQL {
  const tag = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const statement = parts.reduce(
      (sql, part, index) => `${sql}${index === 0 ? '' : `$${index}`}${part}`,
      '',
    )
    return (await transaction.query(statement, values)).rows
  }
  return tag as unknown as SQL
}

async function proofManagedCanonProjects(transaction: Transaction): Promise<void> {
  await transaction.exec(`
    SELECT set_config('app.space_id', '${PLATFORM_SPACE_ID}', true);
    SELECT set_config('app.user_id', '${platformOperatorId}', true);
    INSERT INTO project (id, space_id, name, managed_context, created_at) VALUES
      ('${managedProjectId}', '${PLATFORM_SPACE_ID}', 'managed-proof', true, now()),
      ('${unmanagedProjectId}', '${PLATFORM_SPACE_ID}', 'unmanaged-proof', false, now());
  `)
  const names = await managedCanonProjectNames(sqlTag(transaction), PLATFORM_SPACE_ID)
  if (names.length !== 1 || names[0] !== 'managed-proof') {
    throw new CheckFailure(
      `user-canon managed project selection returned ${JSON.stringify(names)} instead of ["managed-proof"]`,
    )
  }
}

async function proofProjectRelationsStayWithinOneSpace(transaction: Transaction): Promise<void> {
  await transaction.exec(`
    INSERT INTO "user" (id, email, name, created_at)
    VALUES ('${crossSpaceProofUserId}', 'catalogue-space-proof@example.test', 'Catalogue proof', now());
    SELECT set_config('app.space_id', '${crossSpaceProofSpaceId}', true);
    SELECT set_config('app.user_id', '${crossSpaceProofUserId}', true);
    INSERT INTO space (id, name, slug, created_at)
    VALUES ('${crossSpaceProofSpaceId}', 'Catalogue proof', 'catalogue-proof', now());
    INSERT INTO membership (id, space_id, user_id, role, permission, created_at)
    VALUES (
      '01990000-0000-7000-8000-000000000067', '${crossSpaceProofSpaceId}',
      '${crossSpaceProofUserId}', 'owner', 'write', now()
    );
    INSERT INTO project (id, space_id, name, created_at)
    VALUES ('${otherSpaceProjectId}', '${crossSpaceProofSpaceId}', 'other-space-project', now());

    SELECT set_config('app.space_id', '${PLATFORM_SPACE_ID}', true);
    SELECT set_config('app.user_id', '${platformOperatorId}', true);
    INSERT INTO project (id, space_id, name, created_at) VALUES
      ('${sameSpaceSourceProjectId}', '${PLATFORM_SPACE_ID}', 'pair-source-proof', now()),
      ('${sameSpaceTargetProjectId}', '${PLATFORM_SPACE_ID}', 'pair-target-proof', now());
    INSERT INTO port_pair (id, space_id, source_project_id, target_project_id, created_at)
    VALUES (
      '${sameSpacePairId}', '${PLATFORM_SPACE_ID}', '${sameSpaceSourceProjectId}',
      '${sameSpaceTargetProjectId}', now()
    );
  `)

  await transaction.exec('SAVEPOINT cross_space_pair_refusal')
  let refused = false
  try {
    await transaction.exec(`
      INSERT INTO port_pair (id, space_id, source_project_id, target_project_id, created_at)
      VALUES (
        '${crossSpacePairId}', '${PLATFORM_SPACE_ID}', '${sameSpaceSourceProjectId}',
        '${otherSpaceProjectId}', now()
      );
    `)
  } catch {
    refused = true
    await transaction.exec('ROLLBACK TO SAVEPOINT cross_space_pair_refusal')
  }
  await transaction.exec('RELEASE SAVEPOINT cross_space_pair_refusal')
  if (!refused) throw new CheckFailure('DEV-1388 cross-space port pair was accepted')

  const accepted = await transaction.query<{ total: number }>(
    'SELECT count(*)::int AS total FROM port_pair WHERE id = $1',
    [sameSpacePairId],
  )
  if (accepted.rows[0]?.total !== 1) {
    throw new CheckFailure('DEV-1388 same-space port pair was not accepted')
  }
}

async function proofCatalogueDefaultGrants(transaction: Transaction): Promise<void> {
  const privileges = await transaction.query<{
    table_name: string
    actor_select: boolean
    actor_insert: boolean
    actor_update: boolean
    actor_delete: boolean
    reader_select: boolean
  }>(`
    SELECT
      table_name,
      has_table_privilege('${RECORD_ACTOR_ROLE}', table_name, 'SELECT') AS actor_select,
      has_table_privilege('${RECORD_ACTOR_ROLE}', table_name, 'INSERT') AS actor_insert,
      has_table_privilege('${RECORD_ACTOR_ROLE}', table_name, 'UPDATE') AS actor_update,
      has_table_privilege('${RECORD_ACTOR_ROLE}', table_name, 'DELETE') AS actor_delete,
      has_table_privilege('${RECORD_READER_ROLE}', table_name, 'SELECT') AS reader_select
    FROM unnest(ARRAY[
      'workflow', 'workflow_version', 'workflow_event',
      'step_catalogue', 'step_catalogue_version', 'step_catalogue_event',
      'lens', 'lens_revision', 'lens_profile', 'lens_profile_revision',
      'project_lens_profile', 'project_lens_profile_revision',
      'port_doctrine', 'port_ref', 'port_ref_source', 'port_baseline', 'port_pair', 'port_skip'
    ]) AS table_name
  `)
  const missing = privileges.rows.filter(
    (row) =>
      !row.actor_select ||
      !row.actor_insert ||
      !row.actor_update ||
      !row.actor_delete ||
      !row.reader_select,
  )
  if (missing.length > 0) {
    throw new CheckFailure(
      `DEV-1388 catalogue tables did not inherit record grants: ${missing
        .map((row) => row.table_name)
        .join(', ')}`,
    )
  }
}

async function seedHubProjectIdentityBackfill(transaction: Transaction): Promise<void> {
  await transaction.exec(`
    SELECT set_config('app.space_id', '${PLATFORM_SPACE_ID}', true);
    SELECT set_config('app.user_id', '${platformOperatorId}', true);
    INSERT INTO project (id, space_id, name, created_at) VALUES
      ('${hubProjectMatchId}', '${PLATFORM_SPACE_ID}', 'hub-project-id-match', now());
    ALTER TABLE hub_task NO FORCE ROW LEVEL SECURITY;
    INSERT INTO hub_task
      (id, space_id, project_name, key, project, source, first_seen, last_seen, created_at, updated_at)
    VALUES
      ('${hubProjectMatchTaskId}', '${PLATFORM_SPACE_ID}', 'hub-project-id-match', 'HUB-1',
       'hub-project-id-match', 'git', now(), now(), now(), now()),
      ('${hubProjectUnmatchedTaskId}', '${PLATFORM_SPACE_ID}', 'hub-project-id-unmatched', 'HUB-2',
       'hub-project-id-unmatched', 'git', now(), now(), now(), now());
    ALTER TABLE hub_task FORCE ROW LEVEL SECURITY;
    SELECT set_config('app.space_id', '', true);
    SELECT set_config('app.user_id', '', true);
  `)
}

async function hubProjectIdentityTaskRows(
  transaction: Transaction,
): Promise<{ id: string; project_id: string | null }[]> {
  await transaction.exec('ALTER TABLE hub_task NO FORCE ROW LEVEL SECURITY;')
  const result = await transaction.query<{ id: string; project_id: string | null }>(`
    SELECT id::text AS id, project_id::text AS project_id FROM hub_task
    WHERE id IN ('${hubProjectMatchTaskId}', '${hubProjectUnmatchedTaskId}')
    ORDER BY key
  `)
  await transaction.exec('ALTER TABLE hub_task FORCE ROW LEVEL SECURITY;')
  return result.rows
}

async function proofHubProjectIdentityExpand(transaction: Transaction): Promise<void> {
  const expected = [
    { id: hubProjectMatchTaskId, project_id: null },
    { id: hubProjectUnmatchedTaskId, project_id: null },
  ]
  const rows = await hubProjectIdentityTaskRows(transaction)
  if (JSON.stringify(rows) !== JSON.stringify(expected)) {
    throw new CheckFailure(`DEV-1214 hub project_id expand produced ${JSON.stringify(rows)}`)
  }
}

async function proofHubProjectIdentityBackfill(transaction: Transaction): Promise<void> {
  const expected = [
    { id: hubProjectMatchTaskId, project_id: hubProjectMatchId },
    { id: hubProjectUnmatchedTaskId, project_id: null },
  ]
  const rows = await hubProjectIdentityTaskRows(transaction)
  if (JSON.stringify(rows) !== JSON.stringify(expected)) {
    throw new CheckFailure(`DEV-1214 hub project_id backfill produced ${JSON.stringify(rows)}`)
  }
}

async function applyAndProveMigration(
  transaction: Transaction,
  migration: MigrationMeta,
): Promise<void> {
  if (
    migration.name === boardNotifyMigration &&
    !migration.sql.join('\n').includes(`pg_notify('${BOARD_MESSAGE_NOTIFY_CHANNEL}', '')`)
  ) {
    throw new CheckFailure('DEV-1217 board notify migration does not use the exported channel')
  }
  await seedMigrationProof(transaction, migration.name)
  await applyMigration(transaction, migration)
  if (migration.name === brokenDocBackfill && (await proofLatestRevision(transaction)) !== null) {
    throw new CheckFailure('DEV-906 doc backfill unexpectedly populated the proof row')
  }
  if (
    migration.name === repairedDocBackfill &&
    (await proofLatestRevision(transaction)) !== proofRevisionId
  ) {
    throw new CheckFailure('DEV-917 doc backfill did not select the newest proof revision')
  }
  if (migration.name === audienceSetBackfill) await proofAudienceBackfill(transaction)
  if (migration.name === audienceVocabularyBackfill)
    await proofAudienceVocabularyBackfill(transaction)
  if (migration.name === boardSharedSpacesMigration)
    await proofBoardThreadAuthorBackfill(transaction)
  if (migration.name === boardPurposeBackfillMigration) await proofBoardPurposeBackfill(transaction)
  if (migration.name === docJsonbArrayRepair) {
    await proofDocJsonbArrayRepair(transaction)
    for (const chunk of migration.sql) await transaction.exec(chunk)
    await proofDocJsonbArrayRepair(transaction)
  }
  if (migration.name === hubProjectIdentityExpand) await proofHubProjectIdentityExpand(transaction)
  if (migration.name === hubProjectIdentityBackfill)
    await proofHubProjectIdentityBackfill(transaction)
}

async function seedMigrationProof(transaction: Transaction, name: string): Promise<void> {
  if (name === brokenDocBackfill) await seedDocBackfillProof(transaction)
  if (name === audienceVocabularyBackfill) await seedAudienceVocabularyBackfill(transaction)
  if (name === boardSharedSpacesMigration) await seedBoardThreadAuthorBackfill(transaction)
  if (name === docJsonbArrayRepair) await seedDocJsonbArrayRepair(transaction)
  if (name === hubProjectIdentityExpand) await seedHubProjectIdentityBackfill(transaction)
}

async function proofBoardNotifications(database: PGlite): Promise<void> {
  const notifications: string[] = []
  const unlisten = await database.listen(BOARD_MESSAGE_NOTIFY_CHANNEL, (payload) => {
    notifications.push(payload)
  })
  try {
    await database.exec('ALTER TABLE board_message NO FORCE ROW LEVEL SECURITY;')
    await database.exec(`
      INSERT INTO board_message
        (id, author_user_id, kind, purpose, audience, title, body, ack_required, expires_at, created_at)
      VALUES
        ('01990000-0000-7000-8000-000000000024', '${platformOperatorId}', 'notice', 'information', 'operator',
         'Board notify proof', 'insert', false, now() + interval '1 day', now());
    `)
    await database.exec(`
      UPDATE board_message SET body='update'
      WHERE id='01990000-0000-7000-8000-000000000024';
    `)
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (notifications.length !== 2 || notifications.some((payload) => payload !== '')) {
      throw new CheckFailure(
        `DEV-1217 board trigger delivered ${JSON.stringify(notifications)} instead of one empty notification for insert and update`,
      )
    }
  } finally {
    await database.exec('ALTER TABLE board_message FORCE ROW LEVEL SECURITY;')
    await unlisten()
  }
}

async function main(): Promise<void> {
  let database: PGlite | undefined
  let failure: unknown
  let applied = 0
  try {
    let migrations: MigrationMeta[]
    try {
      migrations = readMigrationFiles({ migrationsFolder })
    } catch (error) {
      throw phaseFailure('reading migrations', error)
    }
    try {
      database = new PGlite()
      await database.waitReady
    } catch (error) {
      throw phaseFailure('starting PGlite', error)
    }
    try {
      await provision(database)
    } catch (error) {
      throw phaseFailure('provisioning PGlite', error)
    }
    try {
      await database.transaction(async (transaction) => {
        for (const migration of migrations) await applyAndProveMigration(transaction, migration)
        await proofManagedCanonProjects(transaction)
        await proofProjectRelationsStayWithinOneSpace(transaction)
        await proofCatalogueDefaultGrants(transaction)
      })
      await proofBoardNotifications(database)
    } catch (error) {
      throw error instanceof CheckFailure ? error : phaseFailure('replaying migrations', error)
    }
    applied = migrations.length
  } catch (error) {
    failure = error
  } finally {
    if (database) {
      try {
        await database.close()
      } catch (error) {
        failure ??= phaseFailure('closing PGlite', error)
      }
    }
  }
  if (failure) throw failure
  console.log(`record migrations apply: ${applied} applied`)
}

try {
  await main()
} catch (error) {
  console.error(errorMessage(error))
  process.exitCode = 1
}
