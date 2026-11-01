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
import { proofProjectSpaceOwnershipDeclaration } from './check-record-project-space-ownership.ts'
import * as boardMigrationProof from './record-board-reader-run-backfill-proof.ts'
import {
  docJsonbArrayRepair,
  proofDocJsonbArrayRepair,
  seedDocJsonbArrayRepair,
} from './record-doc-jsonb-repair-proof.ts'
import {
  applyHostedProjectCleanupProof,
  seedHostedProjectCleanupProof,
} from './record-hosted-project-cleanup-proof.ts'
import {
  jsonbStringChecksValidate,
  proofJsonbStringChecksValidate,
  seedJsonbStringChecksValidate,
} from './record-jsonb-string-check-proof.ts'
import {
  CheckFailure,
  errorMessage,
  MigrationFailure,
  phaseFailure,
} from './record-migration-failure.ts'
import { prepareRecordMigrationProof } from './record-migration-session.ts'
import {
  proofRunOwnerRequired,
  runOwnerBackfill,
  runOwnerRequired,
  seedRunOwnerBackfill,
} from './record-run-owner-backfill-proof.ts'
import {
  proofRunTaskReferenceBackfill,
  runTaskReferenceBackfill,
  seedRunTaskReferenceBackfill,
} from './record-run-task-backfill-proof.ts'
import {
  proofTaskChildUuidMigration,
  proofTaskLinkBackfill,
  seedTaskChildUuidBackfill,
  seedTaskLinkBackfill,
  taskChildUuidMigration,
  taskLinkBackfill,
} from './record-task-link-backfill-proof.ts'

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
const hubProjectIdentityExpand = '20261015133608_dev_1214_hub_project_identity'
const hubProjectIdentityBackfill = '20261015133609_dev_1214_hub_project_identity_backfill'
const lensPinContractGuard = '20261101120000_dev_1991_lens_profile_pin_contract_guard'
const proofDocId = '01990000-0000-7000-8000-000000000010'
const proofRevisionId = '01990000-0000-7000-8000-000000000012'
const managedProjectId = '01990000-0000-7000-8000-000000000013'
const unmanagedProjectId = '01990000-0000-7000-8000-000000000014'
const platformOperatorId = '01990000-0000-7000-8000-000000000002'
const publicAudienceProjectId = '01990000-0000-7000-8000-000000000015'
const internalAudienceProjectId = '01990000-0000-7000-8000-000000000016'
const publicAudienceDocId = '01990000-0000-7000-8000-000000000017'
const internalAudienceDocId = '01990000-0000-7000-8000-000000000018'
const hubProjectMatchId = '01990000-0000-7000-8000-000000000050'
const hubProjectMatchTaskId = '01990000-0000-7000-8000-000000000051'
const hubProjectUnmatchedTaskId = '01990000-0000-7000-8000-000000000052'
const crossSpaceProofSpaceId = '01990000-0000-7000-8000-000000000060'
const crossSpaceProofUserId = '01990000-0000-7000-8000-000000000061'
const sameSpaceSourceProjectId = '01990000-0000-7000-8000-000000000062'
const sameSpaceTargetProjectId = '01990000-0000-7000-8000-000000000063'
const otherSpaceProjectId = '01990000-0000-7000-8000-000000000064'
const otherSpaceTargetProjectId = '01990000-0000-7000-8000-000000000066'

const catalogueProofId = (n: number) => `01990000-0000-7000-8000-${n.toString().padStart(12, '0')}`

type CatalogueFixture = {
  projectSource: string
  projectTarget: string
  workflow: string
  workflowVersion: string
  workflowEvent: string
  stepCatalogue: string
  stepCatalogueVersion: string
  stepCatalogueEvent: string
  lens: string
  lensRevision: string
  lensProfile: string
  lensProfileRevision: string
  projectLensProfile: string
  projectLensProfileRevision: string
  portPair: string
  portBaseline: string
  portRef: string
  portRefSource: string
  portSkip: string
}

function catalogueFixture(
  firstId: number,
  projectSource: string,
  projectTarget: string,
): CatalogueFixture {
  const ids = Array.from({ length: 17 }, (_, index) => catalogueProofId(firstId + index))
  return {
    projectSource,
    projectTarget,
    workflow: ids[0]!,
    workflowVersion: ids[1]!,
    workflowEvent: ids[2]!,
    stepCatalogue: ids[3]!,
    stepCatalogueVersion: ids[4]!,
    stepCatalogueEvent: ids[5]!,
    lens: ids[6]!,
    lensRevision: ids[7]!,
    lensProfile: ids[8]!,
    lensProfileRevision: ids[9]!,
    projectLensProfile: ids[10]!,
    projectLensProfileRevision: ids[11]!,
    portPair: ids[12]!,
    portBaseline: ids[13]!,
    portRef: ids[14]!,
    portRefSource: ids[15]!,
    portSkip: ids[16]!,
  }
}

const sameSpaceCatalogue = catalogueFixture(100, sameSpaceSourceProjectId, sameSpaceTargetProjectId)
const otherSpaceCatalogue = catalogueFixture(200, otherSpaceProjectId, otherSpaceTargetProjectId)

function firstLine(sql: string): string {
  return (
    sql
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? '<empty chunk>'
  )
}

function migrationFailure(
  migration: MigrationMeta,
  statement: string,
  error: unknown,
): CheckFailure {
  return new MigrationFailure(
    `shared/record/migrations/${migration.name}/migration.sql failed at ${JSON.stringify(firstLine(statement))}: ${errorMessage(error)}. Fix that migration (never edit a generated one; regenerate it or add a custom one per .agents/contexts/orchestrator-record.md), then rerun ${rerun}.`,
  )
}

export async function provisionRecordDatabase(database: PGlite): Promise<void> {
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

export async function applyRecordMigration(
  transaction: Transaction,
  migration: MigrationMeta,
): Promise<void> {
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
  const revisions = await transaction.query<{
    doc_id: string
    audiences: string[]
  }>('SELECT doc_id, audiences FROM doc_revision WHERE doc_id IN ($1, $2) ORDER BY doc_id', [
    publicAudienceDocId,
    internalAudienceDocId,
  ])
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
  const expectedRevisions = expected.map(({ id, audiences }) => ({
    doc_id: id,
    audiences,
  }))
  if (JSON.stringify(revisions.rows) !== JSON.stringify(expectedRevisions)) {
    throw new CheckFailure(
      `DEV-1238 revision audience vocabulary backfill produced ${JSON.stringify(revisions.rows)}`,
    )
  }
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

function catalogueFixtureSql(spaceId: string, fixture: CatalogueFixture, label: string): string {
  return `
    INSERT INTO workflow (id, space_id, slug, created_at)
    VALUES ('${fixture.workflow}', '${spaceId}', '${label}-workflow', now());
    INSERT INTO workflow_version
      (id, space_id, workflow_id, n, status, definition, author, reason, created_at)
    VALUES (
      '${fixture.workflowVersion}', '${spaceId}', '${fixture.workflow}', 1, 'draft', '{}',
      'migration-check', 'same-space proof', now()
    );
    INSERT INTO workflow_event
      (id, space_id, workflow_version_id, event, author, reason, at)
    VALUES (
      '${fixture.workflowEvent}', '${spaceId}', '${fixture.workflowVersion}', 'set',
      'migration-check', 'same-space proof', now()
    );
    INSERT INTO step_catalogue (id, space_id, slug, created_at)
    VALUES ('${fixture.stepCatalogue}', '${spaceId}', '${label}-steps', now());
    INSERT INTO step_catalogue_version
      (id, space_id, catalogue_id, n, status, definition, author, reason, created_at)
    VALUES (
      '${fixture.stepCatalogueVersion}', '${spaceId}', '${fixture.stepCatalogue}', 1, 'draft',
      '{}', 'migration-check', 'same-space proof', now()
    );
    INSERT INTO step_catalogue_event
      (id, space_id, catalogue_version_id, event, author, reason, at)
    VALUES (
      '${fixture.stepCatalogueEvent}', '${spaceId}', '${fixture.stepCatalogueVersion}', 'set',
      'migration-check', 'same-space proof', now()
    );
    INSERT INTO lens
      (id, space_id, key, title, question, excludes, slots, version)
    VALUES (
      '${fixture.lens}', '${spaceId}', '${label}-lens', 'Proof', 'Question?', '[]', '[]', 1
    );
    INSERT INTO lens_revision
      (id, space_id, lens_id, version, prior_body, reason, at)
    VALUES (
      '${fixture.lensRevision}', '${spaceId}', '${fixture.lens}', 1, '{}',
      'same-space proof', now()
    );
    INSERT INTO lens_profile
      (id, space_id, lens_id, axis, name, version, current_version_id, body)
    VALUES (
      '${fixture.lensProfile}', '${spaceId}', '${fixture.lens}', 'framework', 'proof', 1,
      '${fixture.lensProfile}', '{}'
    );
    INSERT INTO lens_profile_revision
      (id, space_id, profile_id, version, prior_body, reason, at)
    VALUES (
      '${fixture.lensProfileRevision}', '${spaceId}', '${fixture.lensProfile}', 1, '{}',
      'same-space proof', now()
    );
    INSERT INTO project_lens_profile
      (id, space_id, project_id, lens_id, axis, profile_name, selected_version_id)
    VALUES (
      '${fixture.projectLensProfile}', '${spaceId}', '${fixture.projectSource}',
      '${fixture.lens}', 'framework', 'proof', '${fixture.lensProfile}'
    );
    INSERT INTO project_lens_profile_revision
      (id, space_id, selection_id, prior_profile_name, prior_selected_version_id, reason, at)
    VALUES (
      '${fixture.projectLensProfileRevision}', '${spaceId}', '${fixture.projectLensProfile}',
      'proof', '${fixture.lensProfile}', 'same-space proof', now()
    );
    INSERT INTO port_pair (id, space_id, source_project_id, target_project_id, created_at)
    VALUES (
      '${fixture.portPair}', '${spaceId}', '${fixture.projectSource}',
      '${fixture.projectTarget}', now()
    );
    INSERT INTO port_baseline (id, space_id, pair_id)
    VALUES ('${fixture.portBaseline}', '${spaceId}', '${fixture.portPair}');
    INSERT INTO port_ref (id, space_id, task_key, target_project_id, note, created_at)
    VALUES (
      '${fixture.portRef}', '${spaceId}', '${label.toUpperCase()}-1',
      '${fixture.projectTarget}', 'proof', now()
    );
    INSERT INTO port_ref_source
      (id, space_id, ref_id, source_project_id, commits, paths, note)
    VALUES (
      '${fixture.portRefSource}', '${spaceId}', '${fixture.portRef}', '${fixture.projectSource}',
      '[]', '[]', 'proof'
    );
    INSERT INTO port_skip (id, space_id, pair_id, candidate, reason, skipped_at)
    VALUES (
      '${fixture.portSkip}', '${spaceId}', '${fixture.portPair}', '${label}-candidate',
      'proof', now()
    );
  `
}

async function expectCrossSpaceRefusal(
  transaction: Transaction,
  relation: string,
  statement: string,
): Promise<void> {
  await transaction.exec('SAVEPOINT cross_space_refusal')
  let refusal: unknown
  try {
    await transaction.exec(statement)
  } catch (error) {
    refusal = error
  }
  await transaction.exec('ROLLBACK TO SAVEPOINT cross_space_refusal')
  await transaction.exec('RELEASE SAVEPOINT cross_space_refusal')
  if (!refusal) throw new CheckFailure(`DEV-1388 cross-space ${relation} relation was accepted`)
  const code =
    typeof refusal === 'object' && refusal !== null && 'code' in refusal ? refusal.code : undefined
  if (code !== '23503') {
    throw new CheckFailure(
      `DEV-1388 cross-space ${relation} relation produced unexpected SQLSTATE ${String(code)}: ${errorMessage(refusal)}`,
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
    INSERT INTO project (id, space_id, name, created_at) VALUES
      ('${otherSpaceProjectId}', '${crossSpaceProofSpaceId}', 'other-space-source', now()),
      ('${otherSpaceTargetProjectId}', '${crossSpaceProofSpaceId}', 'other-space-target', now());
    ${catalogueFixtureSql(crossSpaceProofSpaceId, otherSpaceCatalogue, 'other')}

    SELECT set_config('app.space_id', '${PLATFORM_SPACE_ID}', true);
    SELECT set_config('app.user_id', '${platformOperatorId}', true);
    INSERT INTO project (id, space_id, name, created_at) VALUES
      ('${sameSpaceSourceProjectId}', '${PLATFORM_SPACE_ID}', 'same-space-source', now()),
      ('${sameSpaceTargetProjectId}', '${PLATFORM_SPACE_ID}', 'same-space-target', now());
    ${catalogueFixtureSql(PLATFORM_SPACE_ID, sameSpaceCatalogue, 'same')}
  `)

  await proofSameSpaceCatalogueRelations(transaction)
  for (const [relation, statement, allowed] of crossSpaceCatalogueRows()) {
    if (allowed) await transaction.exec(statement)
    else await expectCrossSpaceRefusal(transaction, relation, statement)
  }
}

async function proofSameSpaceCatalogueRelations(transaction: Transaction): Promise<void> {
  const rows = [
    ['workflow_version', sameSpaceCatalogue.workflowVersion],
    ['workflow_event', sameSpaceCatalogue.workflowEvent],
    ['step_catalogue_version', sameSpaceCatalogue.stepCatalogueVersion],
    ['step_catalogue_event', sameSpaceCatalogue.stepCatalogueEvent],
    ['lens_revision', sameSpaceCatalogue.lensRevision],
    ['lens_profile', sameSpaceCatalogue.lensProfile],
    ['lens_profile_revision', sameSpaceCatalogue.lensProfileRevision],
    ['project_lens_profile', sameSpaceCatalogue.projectLensProfile],
    ['project_lens_profile_revision', sameSpaceCatalogue.projectLensProfileRevision],
    ['port_pair', sameSpaceCatalogue.portPair],
    ['port_baseline', sameSpaceCatalogue.portBaseline],
    ['port_ref', sameSpaceCatalogue.portRef],
    ['port_ref_source', sameSpaceCatalogue.portRefSource],
    ['port_skip', sameSpaceCatalogue.portSkip],
  ] as const
  for (const [table, id] of rows) {
    const accepted = await transaction.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM ${table} WHERE id = $1`,
      [id],
    )
    if (accepted.rows[0]?.total !== 1) {
      throw new CheckFailure(`DEV-1388 same-space ${table} relation was not accepted`)
    }
  }
}

function crossSpaceCatalogueRows(): readonly (readonly [string, string, boolean?])[] {
  return [
    [
      'workflow version to workflow',
      `INSERT INTO workflow_version (id, space_id, workflow_id, n, status, definition, author, reason, created_at, promoted_at, retired_at) VALUES ('${catalogueProofId(300)}', '${PLATFORM_SPACE_ID}', '${otherSpaceCatalogue.workflow}', 2, 'draft', '{}', 'migration-check', 'proof', now(), NULL, NULL)`,
    ],
    [
      'workflow event to version',
      `INSERT INTO workflow_event (id, space_id, workflow_version_id, event, author, reason, session_id, at) VALUES ('${catalogueProofId(301)}', '${PLATFORM_SPACE_ID}', '${otherSpaceCatalogue.workflowVersion}', 'set', 'migration-check', 'proof', NULL, now())`,
    ],
    [
      'step catalogue version to catalogue',
      `INSERT INTO step_catalogue_version (id, space_id, catalogue_id, n, status, definition, author, reason, created_at, promoted_at, retired_at) VALUES ('${catalogueProofId(302)}', '${PLATFORM_SPACE_ID}', '${otherSpaceCatalogue.stepCatalogue}', 2, 'draft', '{}', 'migration-check', 'proof', now(), NULL, NULL)`,
    ],
    [
      'step catalogue event to version',
      `INSERT INTO step_catalogue_event (id, space_id, catalogue_version_id, event, author, reason, session_id, at) VALUES ('${catalogueProofId(303)}', '${PLATFORM_SPACE_ID}', '${otherSpaceCatalogue.stepCatalogueVersion}', 'set', 'migration-check', 'proof', NULL, now())`,
    ],
    [
      'lens revision to lens',
      `INSERT INTO lens_revision (id, space_id, lens_id, version, prior_body, reason, session_id, at) VALUES ('${catalogueProofId(304)}', '${PLATFORM_SPACE_ID}', '${otherSpaceCatalogue.lens}', 2, '{}', 'proof', NULL, now())`,
    ],
    [
      'lens profile to lens',
      `INSERT INTO lens_profile (id, space_id, lens_id, axis, name, version, current_version_id, body, enabled) VALUES ('${catalogueProofId(305)}', '${PLATFORM_SPACE_ID}', '${otherSpaceCatalogue.lens}', 'architecture', 'cross', 1, '${catalogueProofId(305)}', '{}', true)`,
    ],
    [
      'lens profile revision to profile',
      `INSERT INTO lens_profile_revision (id, space_id, profile_id, version, prior_body, reason, session_id, at) VALUES ('${catalogueProofId(306)}', '${PLATFORM_SPACE_ID}', '${otherSpaceCatalogue.lensProfile}', 2, '{}', 'proof', NULL, now())`,
    ],
    [
      'project lens profile to project',
      `INSERT INTO project_lens_profile (id, space_id, project_id, lens_id, axis, profile_name, selected_version_id) VALUES ('${catalogueProofId(307)}', '${PLATFORM_SPACE_ID}', '${otherSpaceCatalogue.projectSource}', '${sameSpaceCatalogue.lens}', 'architecture', 'cross-project', '${sameSpaceCatalogue.lensProfile}')`,
    ],
    [
      'project lens profile to lens',
      `INSERT INTO project_lens_profile (id, space_id, project_id, lens_id, axis, profile_name, selected_version_id) VALUES ('${catalogueProofId(308)}', '${PLATFORM_SPACE_ID}', '${sameSpaceCatalogue.projectSource}', '${otherSpaceCatalogue.lens}', 'architecture', 'cross-lens', '${otherSpaceCatalogue.lensProfile}')`,
    ],
    [
      'project lens profile revision to selection',
      `INSERT INTO project_lens_profile_revision (id, space_id, selection_id, prior_profile_name, prior_selected_version_id, reason, session_id, at) VALUES ('${catalogueProofId(309)}', '${PLATFORM_SPACE_ID}', '${otherSpaceCatalogue.projectLensProfile}', 'proof', '${otherSpaceCatalogue.lensProfile}', 'proof', NULL, now())`,
    ],
    [
      'port pair to source project',
      `INSERT INTO port_pair (id, space_id, source_project_id, target_project_id, created_at) VALUES ('${catalogueProofId(310)}', '${PLATFORM_SPACE_ID}', '${otherSpaceCatalogue.projectSource}', '${sameSpaceCatalogue.projectTarget}', now())`,
      true,
    ],
    [
      'port pair to target project',
      `INSERT INTO port_pair (id, space_id, source_project_id, target_project_id, created_at) VALUES ('${catalogueProofId(311)}', '${PLATFORM_SPACE_ID}', '${sameSpaceCatalogue.projectSource}', '${otherSpaceCatalogue.projectTarget}', now())`,
    ],
    [
      'port baseline to pair',
      `INSERT INTO port_baseline (id, space_id, pair_id, source_commit, scanned_at) VALUES ('${catalogueProofId(312)}', '${PLATFORM_SPACE_ID}', '${otherSpaceCatalogue.portPair}', NULL, NULL)`,
    ],
    [
      'port ref to project',
      `INSERT INTO port_ref (id, space_id, task_key, target_project_id, note, created_at, resolved_at) VALUES ('${catalogueProofId(313)}', '${PLATFORM_SPACE_ID}', 'CROSS-1', '${otherSpaceCatalogue.projectTarget}', 'proof', now(), NULL)`,
    ],
    [
      'port ref source to ref',
      `INSERT INTO port_ref_source (id, space_id, ref_id, source_project_id, commits, paths, note) VALUES ('${catalogueProofId(314)}', '${PLATFORM_SPACE_ID}', '${otherSpaceCatalogue.portRef}', '${sameSpaceCatalogue.projectSource}', '[]', '[]', 'proof')`,
    ],
    [
      'port ref source to project',
      `INSERT INTO port_ref_source (id, space_id, ref_id, source_project_id, commits, paths, note) VALUES ('${catalogueProofId(315)}', '${PLATFORM_SPACE_ID}', '${sameSpaceCatalogue.portRef}', '${otherSpaceCatalogue.projectSource}', '[]', '[]', 'proof')`,
      true,
    ],
    [
      'port skip to pair',
      `INSERT INTO port_skip (id, space_id, pair_id, candidate, reason, skipped_at) VALUES ('${catalogueProofId(316)}', '${PLATFORM_SPACE_ID}', '${otherSpaceCatalogue.portPair}', 'cross', 'proof', now())`,
    ],
  ] as const
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
  const result = await transaction.query<{
    id: string
    project_id: string | null
  }>(`
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

async function proofDocumentMigration(
  transaction: Transaction,
  migration: MigrationMeta,
): Promise<void> {
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
  if (migration.name === docJsonbArrayRepair) {
    await proofDocJsonbArrayRepair(transaction, {
      spaceId: PLATFORM_SPACE_ID,
      userId: platformOperatorId,
    })
    for (const chunk of migration.sql) await transaction.exec(chunk)
    await proofDocJsonbArrayRepair(transaction, {
      spaceId: PLATFORM_SPACE_ID,
      userId: platformOperatorId,
    })
  }
}

async function proofIdentityMigration(transaction: Transaction, name: string): Promise<void> {
  if (name === hubProjectIdentityExpand) await proofHubProjectIdentityExpand(transaction)
  if (name === hubProjectIdentityBackfill) await proofHubProjectIdentityBackfill(transaction)
  if (name === runTaskReferenceBackfill) await proofRunTaskReferenceBackfill(transaction)
  if (name === taskLinkBackfill)
    await proofTaskLinkBackfill(transaction, {
      spaceId: PLATFORM_SPACE_ID,
      userId: platformOperatorId,
    })
  if (name === taskChildUuidMigration)
    await proofTaskChildUuidMigration(transaction, { spaceId: PLATFORM_SPACE_ID })
  if (name === runOwnerRequired) await proofRunOwnerRequired(transaction)
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
  if (migration.name === lensPinContractGuard)
    await proofLensPinContractGuard(transaction, migration)
  await seedMigrationProof(transaction, migration.name)
  await applyRecordMigration(transaction, migration)
  await proofDocumentMigration(transaction, migration)
  if (migration.name === boardSharedSpacesMigration)
    await boardMigrationProof.proofBoardThreadAuthorBackfill(transaction)
  if (migration.name === boardPurposeBackfillMigration)
    await boardMigrationProof.proofBoardPurposeBackfill(transaction)
  if (migration.name === boardMigrationProof.boardReaderRunBackfill)
    await boardMigrationProof.proofBoardReaderRunBackfill(transaction)
  await proofIdentityMigration(transaction, migration.name)
  if (migration.name === jsonbStringChecksValidate)
    await proofJsonbStringChecksValidate(transaction, PLATFORM_SPACE_ID)
  await applyHostedProjectCleanupProof(transaction, migration)
}

async function seedLensPinContractRow(
  transaction: Transaction,
  selectedVersion: number | null,
): Promise<void> {
  await transaction.exec(`
    ALTER TABLE project_lens_profile NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE lens_profile NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE lens NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE project NO FORCE ROW LEVEL SECURITY;
    INSERT INTO project (id,space_id,name,created_at)
    VALUES ('${catalogueProofId(390)}','${PLATFORM_SPACE_ID}','pin-contract-proof',now());
    INSERT INTO lens (id,space_id,key,title,question,excludes,slots,version)
    VALUES ('${catalogueProofId(391)}','${PLATFORM_SPACE_ID}','pin-contract-proof','Proof','Question?','[]','[]',1);
    INSERT INTO lens_profile
      (id,space_id,lens_id,axis,name,version,current_version_id,body)
    VALUES (
      '${catalogueProofId(392)}','${PLATFORM_SPACE_ID}','${catalogueProofId(391)}',
      'framework','proof',1,'${catalogueProofId(393)}','{}'
    );
    INSERT INTO project_lens_profile
      (id,space_id,project_id,lens_id,axis,profile_name,selected_version,selected_version_id)
    VALUES (
      '${catalogueProofId(394)}','${PLATFORM_SPACE_ID}','${catalogueProofId(390)}',
      '${catalogueProofId(391)}','framework','proof',${selectedVersion ?? 'NULL'},NULL
    );
    ALTER TABLE project_lens_profile FORCE ROW LEVEL SECURITY;
    ALTER TABLE lens_profile FORCE ROW LEVEL SECURITY;
    ALTER TABLE lens FORCE ROW LEVEL SECURITY;
    ALTER TABLE project FORCE ROW LEVEL SECURITY;
  `)
}

async function proofLensPinContractGuard(
  transaction: Transaction,
  migration: MigrationMeta,
): Promise<void> {
  await transaction.exec('SAVEPOINT lens_pin_contract_guard_refusal')
  await seedLensPinContractRow(transaction, 2)
  let refusal: unknown
  try {
    await applyRecordMigration(transaction, migration)
  } catch (error) {
    refusal = error
  }
  await transaction.exec('ROLLBACK TO SAVEPOINT lens_pin_contract_guard_refusal')
  await transaction.exec('RELEASE SAVEPOINT lens_pin_contract_guard_refusal')
  if (!errorMessage(refusal).includes('unresolved lens profile pins block the S4 contract'))
    throw new CheckFailure(
      `DEV-1991 hosted pin guard did not refuse the integer-only row: ${errorMessage(refusal)}`,
    )

  await transaction.exec('SAVEPOINT lens_pin_contract_guard_resolution')
  await seedLensPinContractRow(transaction, 1)
  await applyRecordMigration(transaction, migration)
  await transaction.exec('ALTER TABLE project_lens_profile NO FORCE ROW LEVEL SECURITY')
  const resolved = await transaction.query<{ selected_version_id: string | null }>(
    'SELECT selected_version_id FROM project_lens_profile WHERE id = $1',
    [catalogueProofId(394)],
  )
  if (resolved.rows[0]?.selected_version_id !== catalogueProofId(393))
    throw new CheckFailure('DEV-1991 hosted pin guard did not re-resolve the current-version pin')
  await transaction.exec('ROLLBACK TO SAVEPOINT lens_pin_contract_guard_resolution')
  await transaction.exec('RELEASE SAVEPOINT lens_pin_contract_guard_resolution')

  await seedLensPinContractRow(transaction, null)
}

async function seedMigrationProof(transaction: Transaction, name: string): Promise<void> {
  if (name === brokenDocBackfill) await seedDocBackfillProof(transaction)
  if (name === audienceVocabularyBackfill) await seedAudienceVocabularyBackfill(transaction)
  if (name === boardSharedSpacesMigration)
    await boardMigrationProof.seedBoardThreadAuthorBackfill(transaction)
  if (name === boardMigrationProof.boardReaderRunBackfill)
    await boardMigrationProof.seedBoardReaderRunBackfill(transaction)
  if (name === docJsonbArrayRepair)
    await seedDocJsonbArrayRepair(transaction, {
      spaceId: PLATFORM_SPACE_ID,
      userId: platformOperatorId,
    })
  if (name === hubProjectIdentityExpand) await seedHubProjectIdentityBackfill(transaction)
  if (name === runTaskReferenceBackfill)
    await seedRunTaskReferenceBackfill(transaction, {
      spaceId: PLATFORM_SPACE_ID,
      userId: platformOperatorId,
    })
  if (name === taskLinkBackfill)
    await seedTaskLinkBackfill(transaction, {
      spaceId: PLATFORM_SPACE_ID,
      userId: platformOperatorId,
    })
  if (name === taskChildUuidMigration)
    await seedTaskChildUuidBackfill(transaction, { spaceId: PLATFORM_SPACE_ID })
  if (name === runOwnerBackfill) await seedRunOwnerBackfill(transaction, PLATFORM_SPACE_ID)
  if (name === jsonbStringChecksValidate)
    await seedJsonbStringChecksValidate(transaction, {
      spaceId: PLATFORM_SPACE_ID,
      userId: platformOperatorId,
    })
  await seedHostedProjectCleanupProof(transaction, name)
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
      throw phaseFailure('reading migrations', error, rerun)
    }
    try {
      database = new PGlite()
      await database.waitReady
    } catch (error) {
      throw phaseFailure('starting PGlite', error, rerun)
    }
    try {
      await provisionRecordDatabase(database)
    } catch (error) {
      throw phaseFailure('provisioning PGlite', error, rerun)
    }
    try {
      await database.transaction(async (transaction) => {
        await prepareRecordMigrationProof(transaction, migrations)
        for (const migration of migrations) await applyAndProveMigration(transaction, migration)
        await proofManagedCanonProjects(transaction)
        await proofProjectRelationsStayWithinOneSpace(transaction)
        await proofCatalogueDefaultGrants(transaction)
        await proofProjectSpaceOwnershipDeclaration(transaction)
      })
      await proofBoardNotifications(database)
    } catch (error) {
      throw phaseFailure('replaying migrations', error, rerun)
    }
    applied = migrations.length
  } catch (error) {
    failure = error
  } finally {
    if (database) {
      try {
        await database.close()
      } catch (error) {
        failure ??= phaseFailure('closing PGlite', error, rerun)
      }
    }
  }
  if (failure) throw failure
  console.log(`record migrations apply: ${applied} applied`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(errorMessage(error))
    process.exitCode = 1
  }
}
