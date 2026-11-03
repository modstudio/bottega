// concern: postgres-schema-task-flow
/** Knows the hosted task-flow and stage cursor shapes. Must not know local workflow execution. */
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { hubTask } from './schema-hub.ts'
import { stepCatalogueVersion, workflowVersion } from './schema-workflow-catalogue.ts'
import { machine, project, spaceIdentity, tenantPolicies } from './schema.ts'

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
    workflow: text().notNull(),
    mode: text().notNull(),
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
    totalSteps: integer('total_steps').notNull(),
    openedMachineId: uuid('opened_machine_id')
      .notNull()
      .references(() => machine.id),
    takenOverFromMachineId: uuid('taken_over_from_machine_id').references(() => machine.id),
    lastAdvancedMachineId: uuid('last_advanced_machine_id')
      .notNull()
      .references(() => machine.id),
    revision: integer().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('task_flow_stage_flow_record_id_idx').on(table.flowRecordId),
    ...tenantPolicies('task_flow_stage', table.spaceId),
  ],
)
