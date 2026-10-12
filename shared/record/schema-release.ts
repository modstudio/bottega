// concern: postgres-schema-release
/** Knows the hosted release record shape. Must not know local release or synchronization behavior. */
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
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
    localId: bigint('local_id', { mode: 'bigint' }).notNull(),
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
    unique('release_machine_local_unique').on(table.machineId, table.localId),
    ...tenantPolicies('release', table.spaceId),
  ],
)
