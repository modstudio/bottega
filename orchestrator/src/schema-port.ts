// concern: schema-port
import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'
import { id, project } from './schema-core.ts'
import { review } from './schema-review.ts'

export const portPair = sqliteTable(
  'port_pair',
  {
    id: id(),
    sourceProjectId: integer('source_project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'restrict' }),
    targetProjectId: integer('target_project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'restrict' }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    check('port_pair_distinct_check', sql`${t.sourceProjectId} <> ${t.targetProjectId}`),
    unique('port_pair_source_target_unique').on(t.sourceProjectId, t.targetProjectId),
    index('port_pair_target').on(t.targetProjectId),
  ],
)

export const portBaseline = sqliteTable(
  'port_baseline',
  {
    pairId: integer('pair_id')
      .primaryKey()
      .references(() => portPair.id, { onDelete: 'cascade' }),
    sourceCommit: text('source_commit'),
    scannedAt: text('scanned_at'),
  },
  (t) => [
    check('port_baseline_pair_check', sql`(${t.sourceCommit} is null) = (${t.scannedAt} is null)`),
  ],
)

export const portSkip = sqliteTable(
  'port_skip',
  {
    id: id(),
    pairId: integer('pair_id')
      .notNull()
      .references(() => portPair.id, { onDelete: 'cascade' }),
    candidate: text().notNull(),
    reason: text().notNull(),
    skippedAt: text('skipped_at').notNull(),
  },
  (t) => [
    unique('port_skip_pair_candidate_unique').on(t.pairId, t.candidate),
    index('port_skip_pair').on(t.pairId),
  ],
)

export const portRef = sqliteTable(
  'port_ref',
  {
    taskKey: text('task_key').primaryKey(),
    targetProjectId: integer('target_project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'restrict' }),
    note: text().notNull(),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (t) => [index('port_ref_target').on(t.targetProjectId)],
)

export const portRefSource = sqliteTable(
  'port_ref_source',
  {
    id: id(),
    taskKey: text('task_key')
      .notNull()
      .references(() => portRef.taskKey, { onDelete: 'cascade' }),
    sourceProjectId: integer('source_project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'restrict' }),
    commits: text().notNull(),
    paths: text().notNull(),
    note: text().notNull(),
  },
  (t) => [
    unique('port_ref_source_task_project_unique').on(t.taskKey, t.sourceProjectId),
    index('port_ref_source_task').on(t.taskKey),
  ],
)

export const portDoctrine = sqliteTable(
  'port_doctrine',
  {
    number: integer().primaryKey(),
    title: text().notNull(),
    body: text().notNull(),
    createdAt: text('created_at').notNull(),
    retiredAt: text('retired_at'),
  },
  (t) => [check('port_doctrine_number_check', sql`${t.number} > 0`)],
)

export const landingOverride = sqliteTable(
  'landing_override',
  {
    id: id(),
    recordId: text('record_id').unique(),
    /** @deprecated Use projectId. */ project: text().notNull(),
    projectId: integer('project_id').references(() => project.id, { onDelete: 'restrict' }),
    branch: text().notNull(),
    tip: text().notNull(),
    tree: text().notNull(),
    reason: text().notNull(),
    sessionId: text('session_id'),
    at: text().notNull(),
  },
  (t) => [check('landing_override_reason_check', sql`length(trim(${t.reason})) > 0`)],
)

export const landing = sqliteTable(
  'landing',
  {
    id: id(),
    recordId: text('record_id').unique(),
    /** @deprecated Use projectId. */ project: text().notNull(),
    projectId: integer('project_id').references(() => project.id, { onDelete: 'restrict' }),
    branch: text().notNull(),
    tip: text(),
    trunkBefore: text('trunk_before'),
    status: text().notNull(),
    error: text(),
    sessionId: text('session_id'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    heartbeatDeliveredAt: text('heartbeat_delivered_at'),
    pathSet: text('path_set'),
    requestedAt: text('requested_at'),
    steps: text(),
    causingLandingId: integer('causing_landing_id'),
    claimPid: integer('claim_pid'),
    claimSession: text('claim_session'),
  },
  (t) => [
    check(
      'landing_status_check',
      sql`${t.status} in ('queued','running','landed','refused','install_failed','rebase_required')`,
    ),
    check('landing_path_set_json_check', sql`${t.pathSet} is null or json_valid(${t.pathSet})`),
    check('landing_steps_json_check', sql`${t.steps} is null or json_valid(${t.steps})`),
    index('landing_project_started').on(t.project, t.startedAt),
  ],
)

export const landingReviewCarry = sqliteTable('landing_review_carry', {
  id: id(),
  recordId: text('record_id').unique(),
  /** @deprecated Use projectId. */ project: text().notNull(),
  projectId: integer('project_id').references(() => project.id, { onDelete: 'restrict' }),
  branch: text().notNull(),
  tip: text().notNull(),
  tree: text().notNull(),
  reviewId: integer('review_id')
    .notNull()
    .references(() => review.id),
  reviewedCommit: text('reviewed_commit').notNull(),
  reviewedTree: text('reviewed_tree').notNull(),
  patchId: text('patch_id').notNull(),
  oldBase: text('old_base').notNull(),
  newBase: text('new_base').notNull(),
  sessionId: text('session_id'),
  at: text().notNull(),
})
