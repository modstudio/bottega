import type { Transaction } from '@electric-sql/pglite'
import type { MigrationMeta } from 'drizzle-orm/migrator'
import { PLATFORM_SPACE_ID } from '../shared/record/schema.ts'

const cleanupMigration = '20261019214243_dev_1214_hosted_project_cleanup'
const id = (suffix: number) => `01990000-0000-7000-8000-${String(suffix).padStart(12, '0')}`
const cleanupSpaceId = id(400)
const cleanupLocalProjectId = id(401)
const cleanupMovedProjectId = id(402)
const cleanupDocId = id(403)
const cleanupRevisionId = id(404)
const cleanupResumeId = id(405)
const cleanupResumeRevisionId = id(406)
const cleanupCanonId = id(407)
const cleanupHubTaskId = id(408)
const cleanupHubCommentId = id(409)
const cleanupHubDocumentId = id(410)
const cleanupHubEventId = id(411)
const cleanupHubNoteId = id(412)
const cleanupHubAckId = id(413)
const cleanupHubSubscriptionId = id(414)
const cleanupHubIntervalId = id(415)

export async function seedHostedProjectCleanupProof(
  transaction: Transaction,
  migrationName: string,
): Promise<void> {
  if (migrationName !== cleanupMigration) return
  await transaction.exec(`
    ALTER TABLE space NO FORCE ROW LEVEL SECURITY;
    INSERT INTO space (id, name, slug, created_at)
    VALUES ('${cleanupSpaceId}', 'DEV-1214 cleanup', 'dev-1214-cleanup', now());
    ALTER TABLE project NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE doc NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE doc_revision NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task_comment NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task_document NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task_status_event NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_note NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_note_acknowledgement NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_report_subscription NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_interval NO FORCE ROW LEVEL SECURITY;
    INSERT INTO project (id, space_id, name, created_at) VALUES
      ('${cleanupLocalProjectId}', '${PLATFORM_SPACE_ID}', 'cleanup-local', now()),
      ('${cleanupMovedProjectId}', '${cleanupSpaceId}', 'cleanup-moved', now());
    INSERT INTO doc
      (id,space_id,scope,subject,slug,title,body,delivery,audiences,created_at,updated_at)
    VALUES
      ('${cleanupDocId}','${PLATFORM_SPACE_ID}','project','cleanup-local','local','Local','body','demand',ARRAY['technical'],now(),now()),
      ('${cleanupResumeId}','${PLATFORM_SPACE_ID}','resume','cleanup-moved','brief','Brief','body','demand',ARRAY['technical'],now(),now()),
      ('${cleanupCanonId}','${PLATFORM_SPACE_ID}','canon',NULL,'AGENTS.md','Canon','body','inject',ARRAY['technical'],now(),now());
    INSERT INTO doc_revision
      (id,space_id,doc_id,scope,subject,slug,op,title,body,delivery,audiences,author,reason,at)
    VALUES
      ('${cleanupRevisionId}','${PLATFORM_SPACE_ID}','${cleanupDocId}','project','cleanup-local','local','create','Local','body','demand',ARRAY['technical'],'proof','proof backfill',now()),
      ('${cleanupResumeRevisionId}','${PLATFORM_SPACE_ID}','${cleanupResumeId}','resume','cleanup-moved','brief','create','Brief','body','demand',ARRAY['technical'],'proof','proof move',now());
    INSERT INTO hub_task
      (id,space_id,project_name,key,project,source,first_seen,last_seen,created_at,updated_at)
    VALUES ('${cleanupHubTaskId}','${PLATFORM_SPACE_ID}','unmatched-snapshot','CLEANUP-1','cleanup-local','local',now(),now(),now(),now());
    INSERT INTO hub_task_comment
      (id,space_id,project_name,task_key,body,created_at,updated_at)
    VALUES ('${cleanupHubCommentId}','${PLATFORM_SPACE_ID}','cleanup-local','CLEANUP-1','body',now(),now());
    INSERT INTO hub_task_document
      (id,space_id,project_name,task_key,number,title,body,version,created_at,updated_at)
    VALUES ('${cleanupHubDocumentId}','${PLATFORM_SPACE_ID}','cleanup-local','CLEANUP-1',1,'title','body','1',now(),now());
    INSERT INTO hub_task_status_event
      (id,space_id,project_name,task_key,at,to_status,created_at,updated_at)
    VALUES ('${cleanupHubEventId}','${PLATFORM_SPACE_ID}','cleanup-local','CLEANUP-1',now(),'active',now(),now());
    INSERT INTO hub_note
      (id,space_id,project_name,number,project,text,anchors,sightings,created_at,last_seen_at,updated_at)
    VALUES ('${cleanupHubNoteId}','${PLATFORM_SPACE_ID}','unmatched-snapshot',1,'cleanup-local','note','[]',1,now(),now(),now());
    INSERT INTO hub_note_acknowledgement
      (id,space_id,project_name,note_id,session_id,acknowledged_at,sightings,created_at,updated_at)
    VALUES ('${cleanupHubAckId}','${PLATFORM_SPACE_ID}','cleanup-local','${cleanupHubNoteId}','proof',now(),1,now(),now());
    INSERT INTO hub_report_subscription
      (id,space_id,scope_kind,project_name,cadence,hour,zone,enabled,created_at,updated_at)
    VALUES ('${cleanupHubSubscriptionId}','${PLATFORM_SPACE_ID}','project','cleanup-local','daily',9,'UTC',1,now(),now());
    INSERT INTO hub_interval
      (id,space_id,project_name,source,start_at,end_at,ref,updated_at)
    VALUES ('${cleanupHubIntervalId}','${PLATFORM_SPACE_ID}','cleanup-local','proof',now(),now(),'cleanup',now());
    ALTER TABLE project FORCE ROW LEVEL SECURITY;
    ALTER TABLE doc FORCE ROW LEVEL SECURITY;
    ALTER TABLE doc_revision FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task_comment FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task_document FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task_status_event FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_note FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_note_acknowledgement FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_report_subscription FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_interval FORCE ROW LEVEL SECURITY;
    ALTER TABLE space FORCE ROW LEVEL SECURITY;
  `)
}

async function proveRows(transaction: Transaction): Promise<void> {
  await transaction.exec(`
    ALTER TABLE doc NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE doc_revision NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task_comment NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task_document NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task_status_event NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_note NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_note_acknowledgement NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_report_subscription NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_interval NO FORCE ROW LEVEL SECURITY;
  `)
  const result = await transaction.query<{ failures: number }>(`
    SELECT count(*)::int AS failures FROM (
      SELECT 1 FROM doc WHERE id='${cleanupDocId}' AND project_id IS DISTINCT FROM '${cleanupLocalProjectId}'::uuid
      UNION ALL SELECT 1 FROM doc_revision WHERE id='${cleanupRevisionId}' AND project_id IS DISTINCT FROM '${cleanupLocalProjectId}'::uuid
      UNION ALL SELECT 1 FROM doc WHERE id='${cleanupResumeId}' AND (space_id IS DISTINCT FROM '${cleanupSpaceId}'::uuid OR project_id IS DISTINCT FROM '${cleanupMovedProjectId}'::uuid)
      UNION ALL SELECT 1 FROM doc_revision WHERE id='${cleanupResumeRevisionId}' AND (space_id IS DISTINCT FROM '${cleanupSpaceId}'::uuid OR project_id IS DISTINCT FROM '${cleanupMovedProjectId}'::uuid)
      UNION ALL SELECT 1 FROM doc WHERE id='${cleanupCanonId}' AND (space_id IS DISTINCT FROM '${PLATFORM_SPACE_ID}'::uuid OR project_id IS NOT NULL)
      UNION ALL SELECT 1 FROM hub_task WHERE id='${cleanupHubTaskId}' AND project_id IS DISTINCT FROM '${cleanupLocalProjectId}'::uuid
      UNION ALL SELECT 1 FROM hub_task_comment WHERE id='${cleanupHubCommentId}' AND project_id IS DISTINCT FROM '${cleanupLocalProjectId}'::uuid
      UNION ALL SELECT 1 FROM hub_task_document WHERE id='${cleanupHubDocumentId}' AND project_id IS DISTINCT FROM '${cleanupLocalProjectId}'::uuid
      UNION ALL SELECT 1 FROM hub_task_status_event WHERE id='${cleanupHubEventId}' AND project_id IS DISTINCT FROM '${cleanupLocalProjectId}'::uuid
      UNION ALL SELECT 1 FROM hub_note WHERE id='${cleanupHubNoteId}' AND project_id IS DISTINCT FROM '${cleanupLocalProjectId}'::uuid
      UNION ALL SELECT 1 FROM hub_note_acknowledgement WHERE id='${cleanupHubAckId}' AND project_id IS DISTINCT FROM '${cleanupLocalProjectId}'::uuid
      UNION ALL SELECT 1 FROM hub_report_subscription WHERE id='${cleanupHubSubscriptionId}' AND project_id IS DISTINCT FROM '${cleanupLocalProjectId}'::uuid
      UNION ALL SELECT 1 FROM hub_interval WHERE id='${cleanupHubIntervalId}' AND project_id IS DISTINCT FROM '${cleanupLocalProjectId}'::uuid
    ) invalid
  `)
  if (result.rows[0]?.failures !== 0)
    throw new Error(
      `DEV-1214 hosted project cleanup left ${result.rows[0]?.failures} invalid proof rows`,
    )
  await transaction.exec(`
    ALTER TABLE doc FORCE ROW LEVEL SECURITY;
    ALTER TABLE doc_revision FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task_comment FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task_document FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_task_status_event FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_note FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_note_acknowledgement FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_report_subscription FORCE ROW LEVEL SECURITY;
    ALTER TABLE hub_interval FORCE ROW LEVEL SECURITY;
  `)
}

export async function applyHostedProjectCleanupProof(
  transaction: Transaction,
  migration: MigrationMeta,
): Promise<void> {
  if (migration.name !== cleanupMigration) return
  await proveRows(transaction)
  for (const chunk of migration.sql) await transaction.exec(chunk)
  await proveRows(transaction)
}
