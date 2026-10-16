// concern: postgres-schema-release
/** Knows the hosted release record shape. Must not know local release or synchronization behavior. */
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { machine, project, spaceIdentity, tenantPolicies } from './schema.ts'

export const release = pgTable.withRLS(
  'release',
  {
    id: uuid().primaryKey(),
    spaceId: spaceIdentity(),
    projectId: uuid('project_id').references(() => project.id),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machine.id),
    rung: text().notNull(),
    candidateCommit: text('candidate_commit').notNull(),
    liveCommitBefore: text('live_commit_before'),
    liveCommitAfter: text('live_commit_after'),
    rollback: boolean().notNull(),
    rollbackReason: text('rollback_reason'),
    actor: text().notNull(),
    sessionId: text('session_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    exitCode: integer('exit_code'),
    liveMatchesCandidate: boolean('live_matches_candidate'),
    warning: text(),
    withheldFields: jsonb('withheld_fields'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // Serves latest-per-rung reads; per-project history is accepted to sort at release volume.
    index('release_project_rung_started').on(
      table.projectId,
      table.rung,
      table.startedAt.desc(),
      table.id.desc(),
    ),
    ...tenantPolicies('release', table.spaceId),
  ],
)
