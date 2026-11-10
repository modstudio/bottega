// concern: postgres-schema-task-flow
/** Knows the hosted task-flow and stage cursor shapes. Must not know local workflow execution. */
import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { machine, project, spaceIdentity, tenantPolicies } from './schema.ts'
import { hubTask } from './schema-hub.ts'
import { stepCatalogueVersion, workflowVersion } from './schema-workflow-catalogue.ts'

export const taskFlow = pgTable.withRLS(
  'task_flow',
  {
    id: uuid().primaryKey(),
    spaceId: spaceIdentity(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => project.id),
    taskId: uuid('task_id')
      .notNull()
      .references(() => hubTask.id),
    state: text().notNull(),
    openStageRecordId: uuid('open_stage_record_id'),
    openingMachineId: uuid('opening_machine_id')
      .notNull()
      .references(() => machine.id),
    updatedMachineId: uuid('updated_machine_id')
      .notNull()
      .references(() => machine.id),
    revision: integer().notNull(),
    lastRequestId: uuid('last_request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('task_flow_task_id_idx').on(table.taskId),
    index('task_flow_project_id_idx').on(table.projectId),
    index('task_flow_open_stage_record_id_idx').on(table.openStageRecordId),
    ...tenantPolicies('task_flow', table.spaceId),
  ],
)

export const taskFlowStage = pgTable.withRLS(
  'task_flow_stage',
  {
    id: uuid().primaryKey(),
    spaceId: spaceIdentity(),
    flowRecordId: uuid('flow_record_id')
      .notNull()
      .references(() => taskFlow.id),
    projectId: uuid('project_id').references(() => project.id),
    number: integer(),
    workflow: text().notNull(),
    mode: text().notNull(),
    workflowKey: text('workflow_key'),
    instanceId: text('instance_id'),
    sessionId: text('session_id'),
    workflowVersionId: uuid('workflow_version_id')
      .notNull()
      .references(() => workflowVersion.id),
    catalogueVersionId: uuid('catalogue_version_id')
      .notNull()
      .references(() => stepCatalogueVersion.id),
    arguments: jsonb().notNull(),
    activeOrdinal: integer('active_ordinal').notNull(),
    activeSlug: text('active_slug').notNull(),
    state: text().notNull(),
    closedStepNotes: jsonb('closed_step_notes').notNull(),
    question: text(),
    autonomy: text(),
    enforcement: text(),
    totalSteps: integer('total_steps').notNull(),
    openedMachineId: uuid('opened_machine_id')
      .notNull()
      .references(() => machine.id),
    takenOverFromMachineId: uuid('taken_over_from_machine_id').references(() => machine.id),
    lastAdvancedMachineId: uuid('last_advanced_machine_id')
      .notNull()
      .references(() => machine.id),
    revision: integer().notNull(),
    lastRequestId: uuid('last_request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('task_flow_stage_flow_record_id_idx').on(table.flowRecordId),
    index('task_flow_stage_project_id_idx').on(table.projectId),
    unique('task_flow_stage_project_number_unique').on(table.projectId, table.number),
    uniqueIndex('task_flow_stage_open_slot_unique')
      .on(table.projectId, table.workflow, table.mode, table.workflowKey, table.instanceId)
      .where(sql`${table.state} NOT IN ('done','abandoned')`),
    ...tenantPolicies('task_flow_stage', table.spaceId),
  ],
)

export const workflowObligation = pgTable.withRLS(
  'workflow_obligation',
  {
    id: uuid().primaryKey(),
    spaceId: spaceIdentity(),
    stageRecordId: uuid('stage_record_id')
      .notNull()
      .references(() => taskFlowStage.id, { onDelete: 'cascade' }),
    stepOrdinal: integer('step_ordinal').notNull(),
    stepSlug: text('step_slug').notNull(),
    floor: text().notNull(),
    requirePullRequest: boolean('require_pull_request').notNull().default(false),
    expectedExitCode: integer('expected_exit_code').notNull().default(0),
    expectedStatus: text('expected_status').notNull().default('done'),
    floorDeferrable: boolean('floor_deferrable').notNull().default(true),
    reason: text().notNull(),
    sessionId: text('session_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    satisfiedAt: timestamp('satisfied_at', { withTimezone: true }),
    satisfiedStepOrdinal: integer('satisfied_step_ordinal'),
    satisfiedStepSlug: text('satisfied_step_slug'),
    satisfiedEvidence: jsonb('satisfied_evidence'),
    abandonedAt: timestamp('abandoned_at', { withTimezone: true }),
    abandonedReason: text('abandoned_reason'),
    operatorRuling: boolean('operator_ruling').notNull().default(false),
  },
  (table) => [
    index('workflow_obligation_stage_record_id_idx').on(table.stageRecordId),
    ...tenantPolicies('workflow_obligation', table.spaceId),
  ],
)

export const workflowStepText = pgTable.withRLS(
  'workflow_step_text',
  {
    id: uuid().primaryKey(),
    spaceId: spaceIdentity(),
    stageRecordId: uuid('stage_record_id')
      .notNull()
      .references(() => taskFlowStage.id, { onDelete: 'cascade' }),
    stepOrdinal: integer('step_ordinal').notNull(),
    stepSlug: text('step_slug').notNull(),
    body: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('workflow_step_text_stage_record_id_idx').on(table.stageRecordId),
    ...tenantPolicies('workflow_step_text', table.spaceId),
  ],
)

export const workflowTextCopy = pgTable.withRLS(
  'workflow_text_copy',
  {
    id: uuid().primaryKey(),
    spaceId: spaceIdentity(),
    workflowTextRecordId: uuid('workflow_text_record_id')
      .notNull()
      .references(() => workflowStepText.id),
    stageRecordId: uuid('stage_record_id')
      .notNull()
      .references(() => taskFlowStage.id, { onDelete: 'cascade' }),
    taskDocumentReference: text('task_document_reference').notNull(),
    copiedAt: timestamp('copied_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('workflow_text_copy_workflow_text_record_id_unique').on(table.workflowTextRecordId),
    index('workflow_text_copy_stage_record_id_idx').on(table.stageRecordId),
    ...tenantPolicies('workflow_text_copy', table.spaceId),
  ],
)
