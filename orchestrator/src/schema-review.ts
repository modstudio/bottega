// concern: schema-review
import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core'
import {
  REVIEW_COVERAGE,
  REVIEW_LIMITS,
  REVIEW_OVERLAP,
  REVIEW_REPRODUCED,
  REVIEW_SEVERITY,
} from './review-vocabulary.ts'
import { DELIVERY, FIDELITY, QUALITY } from './score.ts'
import { id, project, run, values } from './schema-core.ts'

export const review = sqliteTable('review', {
  id: id(),
  recordedAt: text('recorded_at').notNull(),
  completedAt: text('completed_at'),
  tier: integer(),
  tierRisk: integer('tier_risk'),
  tierSize: integer('tier_size'),
  tierReasons: text('tier_reasons'),
  tierReason: text('tier_reason'),
  projectId: integer('project_id').references(() => project.id, { onDelete: 'restrict' }),
  patchId: text('patch_id'),
  pathSet: text('path_set'),
  commitMessage: text('commit_message'),
  outdatedAt: text('outdated_at'),
  outdatedReason: text('outdated_reason'),
})

export const reviewLens = sqliteTable(
  'review_lens',
  {
    id: id(),
    reviewId: integer('review_id')
      .notNull()
      .references(() => review.id, { onDelete: 'cascade' }),
    runId: integer('run_id')
      .notNull()
      .unique()
      .references(() => run.id, { onDelete: 'cascade' }),
    lens: text().notNull(),
    agent: text().notNull(),
    model: text(),
    treeInspected: text('tree_inspected'),
    reviewedTree: text('reviewed_tree'),
    standardsRead: text('standards_read').notNull(),
    filesCovered: text('files_covered').notNull(),
    commandsRun: text('commands_run').notNull(),
    couldNotVerify: text('could_not_verify').notNull(),
    mcpTools: text('mcp_tools').notNull().default('[]'),
    docsRead: text('docs_read').notNull().default('[]'),
    substitutes: text().notNull().default('[]'),
    reproduced: text(),
    coverage: text(),
    limits: text(),
    overlap: text(),
  },
  (t) => [
    check(
      'review_lens_reproduced_check',
      sql`${t.reproduced} is null or ${t.reproduced} in (${values(REVIEW_REPRODUCED)})`,
    ),
    check(
      'review_lens_coverage_check',
      sql`${t.coverage} is null or ${t.coverage} in (${values(REVIEW_COVERAGE)})`,
    ),
    check(
      'review_lens_limits_check',
      sql`${t.limits} is null or ${t.limits} in (${values(REVIEW_LIMITS)})`,
    ),
    check(
      'review_lens_overlap_check',
      sql`${t.overlap} is null or ${t.overlap} in (${values(REVIEW_OVERLAP)})`,
    ),
    index('review_calibration').on(t.lens, t.agent, t.model, t.reviewId),
  ],
)

export const reviewFinding = sqliteTable(
  'review_finding',
  {
    id: id(),
    reviewId: integer('review_id')
      .notNull()
      .references(() => review.id, { onDelete: 'cascade' }),
    reviewLensId: integer('review_lens_id')
      .notNull()
      .references(() => reviewLens.id, { onDelete: 'cascade' }),
    ordinal: integer().notNull(),
    severity: text().notNull(),
    location: text().notNull(),
    evidence: text().notNull(),
    proposedCorrection: text('proposed_correction').notNull(),
    disposition: text(),
    rejectionCategory: text('rejection_category'),
    triagedSeverity: text('triaged_severity'),
    triagedAt: text('triaged_at'),
  },
  (t) => [
    unique('review_finding_review_ordinal_unique').on(t.reviewId, t.ordinal),
    check(
      'review_finding_disposition_check',
      sql`${t.disposition} is null or ${t.disposition} in ('accepted','modified','rejected','skipped')`,
    ),
    check(
      'review_finding_severity_check',
      sql`${t.triagedSeverity} is null or ${t.triagedSeverity} in (${values(REVIEW_SEVERITY)})`,
    ),
    check(
      'review_finding_rejection_check',
      sql`${t.disposition} = 'rejected' or ${t.rejectionCategory} is null`,
    ),
  ],
)

export const duel = sqliteTable(
  'duel',
  {
    id: id(),
    job: text().notNull(),
    winnerRunId: integer('winner_run_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    loserRunId: integer('loser_run_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    sessionId: text('session_id'),
    at: text().notNull(),
  },
  (t) => [
    check('duel_distinct_check', sql`${t.winnerRunId} <> ${t.loserRunId}`),
    unique('duel_pair_unique').on(t.winnerRunId, t.loserRunId),
    index('duel_job').on(t.job),
  ],
)

export const comparedPair = sqliteTable(
  'compared_pair',
  {
    runAId: integer('run_a_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    runBId: integer('run_b_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    comparedAt: text('compared_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runAId, t.runBId] }),
    check('compared_pair_order_check', sql`${t.runAId} < ${t.runBId}`),
  ],
)

export const calibration = sqliteTable(
  'calibration',
  {
    id: id(),
    runId: integer('run_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    delivery: text().notNull(),
    quality: text(),
    fidelity: text(),
    at: text().notNull(),
    sessionId: text('session_id'),
  },
  (t) => [
    check('calibration_delivery_check', sql`${t.delivery} in (${values(DELIVERY)})`),
    check('calibration_quality_check', sql`${t.quality} in (${values(QUALITY)})`),
    check(
      'calibration_fidelity_check',
      sql`${t.fidelity} is null or ${t.fidelity} in (${values(FIDELITY)})`,
    ),
    check(
      'calibration_delivery_quality_check',
      sql`(${t.delivery} = 'none') = (${t.quality} is null)`,
    ),
  ],
)
