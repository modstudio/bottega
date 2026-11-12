import type { Transaction } from '@electric-sql/pglite'
import type { MigrationMeta } from 'drizzle-orm/migrator'
import { PLATFORM_SPACE_ID } from '../shared/record/schema.ts'
import { CheckFailure, errorMessage } from './record-migration-failure.ts'

export const taskFlowStageBackfill = '20261112211245_dev_2234_task_flow_stage_backfill'
export const taskFlowStageContract = '20261112211345_dev_2234_task_flow_stage_contract'

const id = (suffix: number) => `01990000-0000-7000-8000-${String(suffix).padStart(12, '0')}`
const userId = id(500)
const machineId = id(501)
const firstProjectId = id(502)
const secondProjectId = id(503)
const workflowId = id(504)
const workflowVersionId = id(505)
const catalogueId = id(506)
const catalogueVersionId = id(507)
const firstFlowId = id(508)
const secondFlowId = id(509)
const firstExistingStageId = id(510)
const firstEarlierStageId = id(511)
const firstLaterStageId = id(512)
const secondExistingStageId = id(513)
const secondEarlierStageId = id(514)
const secondLaterStageId = id(515)
const firstSequenceId = id(516)
const invalidFlowId = id(517)
const invalidStageId = id(518)

const stageValues = (stageId: string, flowId: string, number: number | null, createdAt: string) =>
  `('${stageId}','${PLATFORM_SPACE_ID}','${flowId}',NULL,${number ?? 'NULL'},'proof','default',
    '${workflowVersionId}','${catalogueVersionId}','{}',1,'start','done','[]',1,
    '${machineId}','${machineId}',1,'${createdAt}','${createdAt}')`

export async function seedTaskFlowStageBackfill(transaction: Transaction): Promise<void> {
  await transaction.exec(`
    INSERT INTO "user" (id,email,name,created_at)
    VALUES ('${userId}','dev-2234-stage-proof@example.test','DEV-2234 stage proof',now());
    INSERT INTO machine (id,user_id,name,registered_at,last_seen)
    VALUES ('${machineId}','${userId}','dev-2234-stage-proof',now(),now());

    ALTER TABLE project NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE workflow NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE workflow_version NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE step_catalogue NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE step_catalogue_version NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE task_flow NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE task_flow_stage NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE seq NO FORCE ROW LEVEL SECURITY;

    INSERT INTO project (id,space_id,name,created_at) VALUES
      ('${firstProjectId}','${PLATFORM_SPACE_ID}','stage-backfill-first',now()),
      ('${secondProjectId}','${PLATFORM_SPACE_ID}','stage-backfill-second',now());
    INSERT INTO workflow (id,space_id,slug,created_at)
    VALUES ('${workflowId}','${PLATFORM_SPACE_ID}','stage-backfill-proof',now());
    INSERT INTO workflow_version
      (id,space_id,workflow_id,n,status,definition,author,reason,created_at)
    VALUES ('${workflowVersionId}','${PLATFORM_SPACE_ID}','${workflowId}',1,'production','{}','proof','proof',now());
    INSERT INTO step_catalogue (id,space_id,slug,created_at)
    VALUES ('${catalogueId}','${PLATFORM_SPACE_ID}','stage-backfill-proof',now());
    INSERT INTO step_catalogue_version
      (id,space_id,catalogue_id,n,status,definition,author,reason,created_at)
    VALUES ('${catalogueVersionId}','${PLATFORM_SPACE_ID}','${catalogueId}',1,'production','{}','proof','proof',now());
    INSERT INTO task_flow
      (id,space_id,project_id,state,opening_machine_id,updated_machine_id,revision,created_at,updated_at)
    VALUES
      ('${firstFlowId}','${PLATFORM_SPACE_ID}','${firstProjectId}','done','${machineId}','${machineId}',1,now(),now()),
      ('${secondFlowId}','${PLATFORM_SPACE_ID}','${secondProjectId}','done','${machineId}','${machineId}',1,now(),now());
    INSERT INTO task_flow_stage
      (id,space_id,flow_record_id,project_id,number,workflow,mode,workflow_version_id,
       catalogue_version_id,arguments,active_ordinal,active_slug,state,closed_step_notes,total_steps,
       opened_machine_id,last_advanced_machine_id,revision,created_at,updated_at)
    VALUES
      ${stageValues(firstExistingStageId, firstFlowId, 4, '2026-01-01T00:00:00Z')},
      ${stageValues(firstEarlierStageId, firstFlowId, null, '2026-01-02T00:00:00Z')},
      ${stageValues(firstLaterStageId, firstFlowId, null, '2026-01-03T00:00:00Z')},
      ${stageValues(secondExistingStageId, secondFlowId, 3, '2026-01-01T00:00:00Z')},
      ${stageValues(secondEarlierStageId, secondFlowId, null, '2026-01-02T00:00:00Z')},
      ${stageValues(secondLaterStageId, secondFlowId, null, '2026-01-03T00:00:00Z')};
    INSERT INTO seq (id,space_id,project_id,name,next)
    VALUES ('${firstSequenceId}','${PLATFORM_SPACE_ID}','${firstProjectId}','task_flow_stage',8);

    ALTER TABLE seq FORCE ROW LEVEL SECURITY;
    ALTER TABLE task_flow_stage FORCE ROW LEVEL SECURITY;
    ALTER TABLE task_flow FORCE ROW LEVEL SECURITY;
    ALTER TABLE step_catalogue_version FORCE ROW LEVEL SECURITY;
    ALTER TABLE step_catalogue FORCE ROW LEVEL SECURITY;
    ALTER TABLE workflow_version FORCE ROW LEVEL SECURITY;
    ALTER TABLE workflow FORCE ROW LEVEL SECURITY;
    ALTER TABLE project FORCE ROW LEVEL SECURITY;
  `)
}

export async function proofTaskFlowStageMissingProjectRefusal(
  transaction: Transaction,
  migration: MigrationMeta,
): Promise<void> {
  await transaction.exec('SAVEPOINT task_flow_stage_missing_project')
  await transaction.exec(`
    ALTER TABLE task_flow NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE task_flow_stage NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE task_flow ALTER COLUMN project_id DROP NOT NULL;
    INSERT INTO task_flow
      (id,space_id,project_id,state,opening_machine_id,updated_machine_id,revision,created_at,updated_at)
    VALUES ('${invalidFlowId}','${PLATFORM_SPACE_ID}',NULL,'done','${machineId}','${machineId}',1,now(),now());
    INSERT INTO task_flow_stage
      (id,space_id,flow_record_id,project_id,number,workflow,mode,workflow_version_id,
       catalogue_version_id,arguments,active_ordinal,active_slug,state,closed_step_notes,total_steps,
       opened_machine_id,last_advanced_machine_id,revision,created_at,updated_at)
    VALUES ${stageValues(invalidStageId, invalidFlowId, null, '2026-01-04T00:00:00Z')};
  `)
  let refusal: unknown
  try {
    for (const chunk of migration.sql) await transaction.exec(chunk)
  } catch (error) {
    refusal = error
  }
  await transaction.exec('ROLLBACK TO SAVEPOINT task_flow_stage_missing_project')
  await transaction.exec('RELEASE SAVEPOINT task_flow_stage_missing_project')
  const message = errorMessage(refusal)
  if (!message.includes(invalidStageId) || !message.includes('has a flow with no project')) {
    throw new CheckFailure(
      `DEV-2234 task-flow stage backfill did not identify the invalid stage: ${message}`,
    )
  }
}

type BackfilledStage = { id: string; project_id: string; number: number }
type BackfilledSequence = { project_id: string; next: string }

async function backfillResult(transaction: Transaction): Promise<{
  stages: BackfilledStage[]
  sequences: BackfilledSequence[]
}> {
  await transaction.exec(`
    ALTER TABLE task_flow_stage NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE seq NO FORCE ROW LEVEL SECURITY;
  `)
  const stages = await transaction.query<BackfilledStage>(`
    SELECT id::text AS id, project_id::text AS project_id, number
    FROM task_flow_stage
    WHERE id IN (
      '${firstExistingStageId}','${firstEarlierStageId}','${firstLaterStageId}',
      '${secondExistingStageId}','${secondEarlierStageId}','${secondLaterStageId}'
    )
    ORDER BY id
  `)
  const sequences = await transaction.query<BackfilledSequence>(`
    SELECT project_id::text AS project_id, next::text AS next
    FROM seq
    WHERE project_id IN ('${firstProjectId}','${secondProjectId}')
      AND name='task_flow_stage'
    ORDER BY project_id
  `)
  await transaction.exec(`
    ALTER TABLE seq FORCE ROW LEVEL SECURITY;
    ALTER TABLE task_flow_stage FORCE ROW LEVEL SECURITY;
  `)
  return { stages: stages.rows, sequences: sequences.rows }
}

export async function proofTaskFlowStageBackfill(
  transaction: Transaction,
  migration: MigrationMeta,
): Promise<void> {
  const expected = {
    stages: [
      { id: firstExistingStageId, project_id: firstProjectId, number: 4 },
      { id: firstEarlierStageId, project_id: firstProjectId, number: 8 },
      { id: firstLaterStageId, project_id: firstProjectId, number: 9 },
      { id: secondExistingStageId, project_id: secondProjectId, number: 3 },
      { id: secondEarlierStageId, project_id: secondProjectId, number: 4 },
      { id: secondLaterStageId, project_id: secondProjectId, number: 5 },
    ].sort((left, right) => left.id.localeCompare(right.id)),
    sequences: [
      { project_id: firstProjectId, next: '10' },
      { project_id: secondProjectId, next: '6' },
    ],
  }
  const first = await backfillResult(transaction)
  if (JSON.stringify(first) !== JSON.stringify(expected)) {
    throw new CheckFailure(`DEV-2234 task-flow stage backfill produced ${JSON.stringify(first)}`)
  }
  for (const chunk of migration.sql) await transaction.exec(chunk)
  const second = await backfillResult(transaction)
  if (JSON.stringify(second) !== JSON.stringify(first)) {
    throw new CheckFailure(
      `DEV-2234 task-flow stage backfill was not idempotent: ${JSON.stringify(second)}`,
    )
  }
}

export async function proofTaskFlowStageContract(transaction: Transaction): Promise<void> {
  const columns = await transaction.query<{ column_name: string; is_nullable: string }>(`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='task_flow_stage'
      AND column_name IN ('project_id','number')
    ORDER BY column_name
  `)
  if (
    JSON.stringify(columns.rows) !==
    JSON.stringify([
      { column_name: 'number', is_nullable: 'NO' },
      { column_name: 'project_id', is_nullable: 'NO' },
    ])
  ) {
    throw new CheckFailure(
      `DEV-2234 task-flow stage contract produced ${JSON.stringify(columns.rows)}`,
    )
  }
}
