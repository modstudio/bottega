// concern: postgres-schema-review
/** Knows the hosted review record shape. Must not know local review or synchronization behavior. */
import { bigint, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { machine, project, spaceIdentity, tenantPolicies } from './postgres-schema.ts'

const recordIdentity = () => uuid().primaryKey()
const machineIdentity = () =>
  uuid('machine_id')
    .notNull()
    .references(() => machine.id)
const localIdentity = () => bigint('local_id', { mode: 'bigint' }).notNull()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull()

export const review = pgTable.withRLS(
  'review',
  {
    id: recordIdentity(),
    spaceId: spaceIdentity(),
    projectId: uuid('project_id').references(() => project.id),
    machineId: machineIdentity(),
    localId: localIdentity(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    tier: integer(),
    tierRisk: integer('tier_risk'),
    tierSize: integer('tier_size'),
    tierReasons: jsonb('tier_reasons'),
    tierReason: text('tier_reason'),
    patchId: text('patch_id'),
    pathSet: jsonb('path_set'),
    commitMessage: text('commit_message'),
    outdatedAt: timestamp('outdated_at', { withTimezone: true }),
    outdatedReason: text('outdated_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('review_machine_local_unique').on(table.machineId, table.localId),
    ...tenantPolicies('review', table.spaceId),
  ],
)

export const reviewLens = pgTable.withRLS(
  'review_lens',
  {
    id: recordIdentity(),
    spaceId: spaceIdentity(),
    reviewId: uuid('review_id').notNull(),
    runId: uuid('run_id').notNull(),
    machineId: machineIdentity(),
    localId: localIdentity(),
    lens: text().notNull(),
    agent: text().notNull(),
    model: text(),
    treeInspected: text('tree_inspected'),
    reviewedTree: text('reviewed_tree'),
    standardsRead: jsonb('standards_read').notNull(),
    filesCovered: jsonb('files_covered').notNull(),
    commandsRun: jsonb('commands_run').notNull(),
    couldNotVerify: jsonb('could_not_verify').notNull(),
    mcpTools: jsonb('mcp_tools').notNull(),
    docsRead: jsonb('docs_read').notNull(),
    substitutes: jsonb().notNull(),
    reproduced: text(),
    coverage: text(),
    limits: text(),
    overlap: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('review_lens_machine_local_unique').on(table.machineId, table.localId),
    ...tenantPolicies('review_lens', table.spaceId),
  ],
)

export const reviewFinding = pgTable.withRLS(
  'review_finding',
  {
    id: recordIdentity(),
    spaceId: spaceIdentity(),
    reviewId: uuid('review_id').notNull(),
    reviewLensId: uuid('review_lens_id').notNull(),
    machineId: machineIdentity(),
    localId: localIdentity(),
    ordinal: integer().notNull(),
    severity: text().notNull(),
    location: text().notNull(),
    evidence: text().notNull(),
    proposedCorrection: text('proposed_correction').notNull(),
    disposition: text(),
    rejectionCategory: text('rejection_category'),
    triagedSeverity: text('triaged_severity'),
    triagedAt: timestamp('triaged_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('review_finding_machine_local_unique').on(table.machineId, table.localId),
    ...tenantPolicies('review_finding', table.spaceId),
  ],
)
