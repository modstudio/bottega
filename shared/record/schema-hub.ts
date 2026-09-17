// concern: postgres-schema-hub
/** Hosted record shapes for evidence created by hub's local collectors. */

import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
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

export const hubTask = pgTable.withRLS(
  'hub_task',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    projectName: text('project_name').notNull(),
    key: text().notNull(),
    project: text().notNull(),
    title: text(),
    status: text(),
    statusCategory: text('status_category'),
    parentKey: text('parent_key'),
    body: text(),
    assignee: text(),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    source: text().notNull(),
    firstSeen: timestamp('first_seen', { withTimezone: true }).notNull(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('hub_task_space_key_unique').on(table.spaceId, table.key),
    check(
      'hub_task_status_category_check',
      sql`${table.statusCategory} IS NULL OR ${table.statusCategory} IN ('open','active','review','done','dropped')`,
    ),
    check('hub_task_source_check', sql`${table.source} IN ('mcp','git','local')`),
    ...tenantPolicies('hub_task', table.spaceId),
  ],
)

export const hubTaskComment = pgTable.withRLS(
  'hub_task_comment',
  {
    id: identity(),
    legacyLocalId: bigint('legacy_local_id', { mode: 'bigint' }),
    spaceId: spaceIdentity(),
    projectName: text('project_name').notNull(),
    taskKey: text('task_key').notNull(),
    body: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('hub_task_comment_space_id_unique').on(table.spaceId, table.id),
    unique('hub_task_comment_legacy_unique').on(table.spaceId, table.legacyLocalId),
    ...tenantPolicies('hub_task_comment', table.spaceId),
  ],
)

export const hubTaskDocument = pgTable.withRLS(
  'hub_task_document',
  {
    id: identity(),
    legacyLocalId: bigint('legacy_local_id', { mode: 'bigint' }),
    spaceId: spaceIdentity(),
    projectName: text('project_name').notNull(),
    taskKey: text('task_key').notNull(),
    role: text(),
    title: text().notNull(),
    body: text().notNull(),
    version: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('hub_task_document_space_id_unique').on(table.spaceId, table.id),
    unique('hub_task_document_legacy_unique').on(table.spaceId, table.legacyLocalId),
    check('hub_task_document_role_check', sql`${table.role} IS NULL OR ${table.role} = 'handoff'`),
    ...tenantPolicies('hub_task_document', table.spaceId),
  ],
)

export const hubTaskStatusEvent = pgTable.withRLS(
  'hub_task_status_event',
  {
    id: identity(),
    legacyLocalId: bigint('legacy_local_id', { mode: 'bigint' }),
    spaceId: spaceIdentity(),
    projectName: text('project_name').notNull(),
    taskKey: text('task_key').notNull(),
    at: timestamp({ withTimezone: true }).notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('hub_task_status_event_space_id_unique').on(table.spaceId, table.id),
    unique('hub_task_status_event_legacy_unique').on(table.spaceId, table.legacyLocalId),
    unique('hub_task_status_event_change_unique').on(
      table.spaceId,
      table.taskKey,
      table.toStatus,
      table.at,
    ),
    ...tenantPolicies('hub_task_status_event', table.spaceId),
  ],
)

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
