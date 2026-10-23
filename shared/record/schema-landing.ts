// concern: postgres-schema-landing
/** Knows the hosted landing and operational-evidence record shape. Must not know local execution or synchronization. */
import { sql } from 'drizzle-orm'
import { bigint, check, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { machine, project, spaceIdentity, tenantPolicies } from './schema.ts'

const recordIdentity = () => uuid().primaryKey()
const machineIdentity = () =>
  uuid('machine_id')
    .notNull()
    .references(() => machine.id)
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull()
const recordedAt = (name: string) => timestamp(name, { withTimezone: true }).notNull()

export const landing = pgTable.withRLS(
  'landing',
  {
    id: recordIdentity(),
    spaceId: spaceIdentity(),
    projectId: uuid('project_id').references(() => project.id),
    machineId: machineIdentity(),
    branch: text().notNull(),
    tip: text(),
    trunkBefore: text('trunk_before'),
    status: text().notNull(),
    error: text(),
    sessionId: text('session_id'),
    startedAt: recordedAt('started_at'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    pathSet: jsonb('path_set'),
    requestedAt: timestamp('requested_at', { withTimezone: true }),
    steps: jsonb(),
    causingLandingId: uuid('causing_landing_id'),
    withheldFields: jsonb('withheld_fields'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [...tenantPolicies('landing', table.spaceId)],
)

export const landingOverride = pgTable.withRLS(
  'landing_override',
  {
    id: recordIdentity(),
    spaceId: spaceIdentity(),
    projectId: uuid('project_id').references(() => project.id),
    machineId: machineIdentity(),
    branch: text().notNull(),
    tip: text().notNull(),
    tree: text().notNull(),
    patchId: text('patch_id'),
    pathSet: jsonb('path_set'),
    reason: text().notNull(),
    attribution: text().notNull().default('operator'),
    missingLenses: jsonb('missing_lenses').notNull().default([]),
    sessionId: text('session_id'),
    at: recordedAt('at'),
    withheldFields: jsonb('withheld_fields'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    ...tenantPolicies('landing_override', table.spaceId),
    check(
      'landing_override_attribution_check',
      sql`${table.attribution} IN ('operator','architect-ceiling')`,
    ),
    check(
      'landing_override_missing_lenses_check',
      sql`jsonb_typeof(${table.missingLenses}) = 'array'`,
    ),
  ],
)

export const landingReviewCarry = pgTable.withRLS(
  'landing_review_carry',
  {
    id: recordIdentity(),
    spaceId: spaceIdentity(),
    projectId: uuid('project_id').references(() => project.id),
    machineId: machineIdentity(),
    branch: text().notNull(),
    tip: text().notNull(),
    tree: text().notNull(),
    reviewId: uuid('review_id').notNull(),
    reviewedCommit: text('reviewed_commit').notNull(),
    reviewedTree: text('reviewed_tree').notNull(),
    patchId: text('patch_id').notNull(),
    oldBase: text('old_base').notNull(),
    newBase: text('new_base').notNull(),
    sessionId: text('session_id'),
    at: recordedAt('at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [...tenantPolicies('landing_review_carry', table.spaceId)],
)

export const landingTriageSnapshot = pgTable.withRLS(
  'landing_triage_snapshot',
  {
    id: recordIdentity(),
    spaceId: spaceIdentity(),
    projectId: uuid('project_id').references(() => project.id),
    machineId: machineIdentity(),
    branch: text().notNull(),
    tip: text().notNull(),
    tree: text().notNull(),
    prNumber: integer('pr_number').notNull(),
    reviewIds: jsonb('review_ids').notNull(),
    patchId: text('patch_id').notNull(),
    tier: integer().notNull(),
    lensRounds: integer('lens_rounds').notNull(),
    findingCount: integer('finding_count').notNull(),
    admissionPath: text('admission_path').notNull().default('exact_review'),
    readId: uuid('read_id'),
    overrideId: uuid('override_id'),
    sessionId: text('session_id'),
    at: recordedAt('at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [...tenantPolicies('landing_triage_snapshot', table.spaceId)],
)

export const contention = pgTable.withRLS(
  'contention',
  {
    id: recordIdentity(),
    spaceId: spaceIdentity(),
    machineId: machineIdentity(),
    at: recordedAt('at'),
    sessionId: text('session_id'),
    resourceKind: text('resource_kind').notNull(),
    resourceKey: text('resource_key').notNull(),
    eventKind: text('event_kind').notNull(),
    durationMs: bigint('duration_ms', { mode: 'bigint' }),
    cause: text(),
    runId: uuid('run_id'),
    landingId: uuid('landing_id'),
    withheldFields: jsonb('withheld_fields'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [...tenantPolicies('contention', table.spaceId)],
)

export const testFlake = pgTable.withRLS(
  'test_flake',
  {
    id: recordIdentity(),
    spaceId: spaceIdentity(),
    projectId: uuid('project_id').references(() => project.id),
    machineId: machineIdentity(),
    test: text().notNull(),
    file: text().notNull(),
    loadAtFailure: jsonb('load_at_failure').notNull(),
    signal: text(),
    at: recordedAt('at'),
    withheldFields: jsonb('withheld_fields'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [...tenantPolicies('test_flake', table.spaceId)],
)

export const branchDisposal = pgTable.withRLS(
  'branch_disposal',
  {
    id: recordIdentity(),
    spaceId: spaceIdentity(),
    projectId: uuid('project_id').references(() => project.id),
    machineId: machineIdentity(),
    branch: text().notNull(),
    tip: text().notNull(),
    taskKey: text('task_key'),
    reason: text().notNull(),
    note: text().notNull(),
    archiveRef: text('archive_ref').notNull(),
    archiveExpiresAt: recordedAt('archive_expires_at'),
    actorSession: text('actor_session').notNull(),
    disposedAt: recordedAt('disposed_at'),
    withheldFields: jsonb('withheld_fields'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [...tenantPolicies('branch_disposal', table.spaceId)],
)
