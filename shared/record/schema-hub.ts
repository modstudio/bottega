// concern: postgres-schema-hub
/** Hosted record shapes for evidence created by hub's local collectors. */
import {
  doublePrecision,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { spaceIdentity, tenantPolicies } from './schema.ts'

const identity = () => uuid('id').primaryKey()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull()

export const hubInterval = pgTable.withRLS(
  'hub_interval',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    taskKey: text('task_key'),
    projectName: text('project_name'),
    source: text().notNull(),
    agent: text(),
    job: text(),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }).notNull(),
    claudeTokens: integer('claude_tokens').notNull().default(0),
    vendorTokens: integer('vendor_tokens').notNull().default(0),
    vendorCostUsd: doublePrecision('vendor_cost_usd'),
    ref: text().notNull(),
    via: text(),
    open: integer().notNull().default(0),
    sessionId: text('session_id'),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('hub_interval_natural_key').on(table.spaceId, table.source, table.ref, table.startAt),
    ...tenantPolicies('hub_interval', table.spaceId),
  ],
)

export const hubDay = pgTable.withRLS(
  'hub_day',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    day: text().notNull(),
    claudeTokens: integer('claude_tokens').notNull().default(0),
    cacheRead: integer('cache_read').notNull().default(0),
    messages: integer().notNull().default(0),
    tasks: integer().notNull().default(0),
    canonTokens: integer('canon_tokens').notNull().default(0),
    otherTokens: integer('other_tokens').notNull().default(0),
    commits: integer().notNull().default(0),
    files: integer().notNull().default(0),
    linesProduct: integer('lines_product').notNull().default(0),
    linesTest: integer('lines_test').notNull().default(0),
    linesDocs: integer('lines_docs').notNull().default(0),
    linesConfig: integer('lines_config').notNull().default(0),
    linesGenerated: integer('lines_generated').notNull().default(0),
    collectedAt: timestamp('collected_at', { withTimezone: true }).notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('hub_day_natural_key').on(table.spaceId, table.day),
    ...tenantPolicies('hub_day', table.spaceId),
  ],
)
