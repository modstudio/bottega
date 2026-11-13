// concern: postgres-schema-session
/** Hosted measurements of session context delivered by this machine. */

import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { machine, spaceIdentity, tenantPolicies } from './schema.ts'

export const SESSION_START_SOURCES = ['startup', 'resume', 'clear', 'compact', 'fork'] as const

export const briefInjection = pgTable.withRLS(
  'brief_injection',
  {
    id: uuid().primaryKey(),
    spaceId: spaceIdentity(),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machine.id),
    sessionId: text('session_id').notNull(),
    at: timestamp({ withTimezone: true }).notNull(),
    source: text().notNull(),
    bytes: integer().notNull(),
    lines: integer().notNull(),
    cursors: integer().notNull(),
    keylessCursors: integer('keyless_cursors').notNull(),
    keylessIdleMaxMs: bigint('keyless_idle_max_ms', { mode: 'bigint' }),
    overCap: boolean('over_cap').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    ...tenantPolicies('brief_injection', table.spaceId),
    index('brief_injection_session_at_idx').on(table.sessionId, table.at),
    check(
      'brief_injection_source_check',
      sql`${table.source} IN (${sql.raw(SESSION_START_SOURCES.map((source) => `'${source}'`).join(','))})`,
    ),
    check('brief_injection_bytes_check', sql`${table.bytes} >= 0`),
    check('brief_injection_lines_check', sql`${table.lines} >= 0`),
    check('brief_injection_cursors_check', sql`${table.cursors} >= 0`),
    check(
      'brief_injection_keyless_cursors_check',
      sql`${table.keylessCursors} >= 0 AND ${table.keylessCursors} <= ${table.cursors}`,
    ),
    check(
      'brief_injection_keyless_idle_max_ms_check',
      sql`${table.keylessIdleMaxMs} IS NULL OR ${table.keylessIdleMaxMs} >= 0`,
    ),
  ],
)
