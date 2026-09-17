// concern: postgres-schema-snapshots
/** Hosted latest-value snapshots for machine-local orchestrator views. */
import { sql } from 'drizzle-orm'
import { check, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { spaceIdentity, tenantPolicies } from './schema.ts'

export const orchSnapshot = pgTable.withRLS(
  'orch_snapshot',
  {
    id: uuid('id').primaryKey(),
    spaceId: spaceIdentity(),
    kind: text().notNull(),
    machineId: uuid('machine_id').notNull(),
    payload: jsonb().notNull(),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      'orch_snapshot_kind_check',
      sql`${table.kind} IN ('state','blockers','health','jobs','agents')`,
    ),
    unique('orch_snapshot_latest_per_machine').on(table.spaceId, table.kind, table.machineId),
    ...tenantPolicies('orch_snapshot', table.spaceId),
  ],
)
