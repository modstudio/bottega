// concern: postgres-schema-hub
/** Hosted record shapes for evidence created by hub's local collectors. */

import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  check,
  doublePrecision,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { spaceIdentity, tenantPolicies, user } from './schema.ts'

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
    parentId: uuid('parent_id').references((): AnyPgColumn => hubTask.id, {
      onDelete: 'set null',
    }),
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
    index('hub_task_parent_id_idx').on(table.parentId),
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
    taskId: uuid('task_id').references(() => hubTask.id, { onDelete: 'cascade' }),
    body: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('hub_task_comment_space_id_unique').on(table.spaceId, table.id),
    unique('hub_task_comment_legacy_unique').on(table.spaceId, table.legacyLocalId),
    index('hub_task_comment_task_id_idx').on(table.taskId),
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
    taskId: uuid('task_id').references(() => hubTask.id, { onDelete: 'cascade' }),
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
    index('hub_task_document_task_id_idx').on(table.taskId),
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
    taskId: uuid('task_id').references(() => hubTask.id, { onDelete: 'cascade' }),
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
    index('hub_task_status_event_task_id_idx').on(table.taskId),
    ...tenantPolicies('hub_task_status_event', table.spaceId),
  ],
)

export const hubNote = pgTable.withRLS(
  'hub_note',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    projectName: text('project_name').notNull(),
    number: bigint({ mode: 'number' }).notNull(),
    project: text().notNull(),
    text: text().notNull(),
    area: text(),
    anchors: text().notNull(),
    sightings: integer().notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    staleAt: timestamp('stale_at', { withTimezone: true }),
    staleReason: text('stale_reason'),
    promotedTask: text('promoted_task'),
    promotedTaskId: uuid('promoted_task_id').references(() => hubTask.id, {
      onDelete: 'set null',
    }),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('hub_note_space_number_unique').on(table.spaceId, table.number),
    index('hub_note_promoted_task_id_idx').on(table.promotedTaskId),
    check('hub_note_sightings_check', sql`${table.sightings} > 0`),
    ...tenantPolicies('hub_note', table.spaceId),
  ],
)

export const hubNoteAcknowledgement = pgTable.withRLS(
  'hub_note_acknowledgement',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    projectName: text('project_name').notNull(),
    noteId: uuid('note_id').notNull(),
    sessionId: text('session_id').notNull(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }).notNull(),
    sightings: integer().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('hub_note_ack_space_session_unique').on(table.spaceId, table.noteId, table.sessionId),
    check('hub_note_ack_sightings_check', sql`${table.sightings} > 0`),
    ...tenantPolicies('hub_note_acknowledgement', table.spaceId),
  ],
)

export const hubReportSubscription = pgTable.withRLS(
  'hub_report_subscription',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    scopeKind: text('scope_kind').notNull(),
    projectName: text('project_name'),
    cadence: text().notNull(),
    hour: integer().notNull(),
    weekday: text(),
    zone: text().notNull(),
    enabled: integer().notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'hub_report_subscription_scope_kind_check',
      sql`${table.scopeKind} IN ('space','project','members')`,
    ),
    check(
      'hub_report_subscription_scope_check',
      sql`(${table.scopeKind} = 'space' AND ${table.projectName} IS NULL)
        OR (${table.scopeKind} = 'project' AND ${table.projectName} IS NOT NULL)
        OR (${table.scopeKind} = 'members' AND ${table.projectName} IS NULL)`,
    ),
    check('hub_report_subscription_cadence_check', sql`${table.cadence} IN ('daily','weekly')`),
    check('hub_report_subscription_hour_check', sql`${table.hour} >= 0 AND ${table.hour} <= 23`),
    check(
      'hub_report_subscription_weekday_check',
      sql`(${table.cadence} = 'daily' AND ${table.weekday} IS NULL)
        OR (${table.cadence} = 'weekly' AND ${table.weekday} IN ('monday','tuesday','wednesday','thursday','friday','saturday','sunday'))`,
    ),
    check('hub_report_subscription_zone_check', sql`char_length(${table.zone}) > 0`),
    check('hub_report_subscription_enabled_check', sql`${table.enabled} IN (0,1)`),
    ...tenantPolicies('hub_report_subscription', table.spaceId),
  ],
)

export const hubReportSubscriptionMember = pgTable.withRLS(
  'hub_report_subscription_member',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => hubReportSubscription.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('hub_report_subscription_member_unique').on(table.subscriptionId, table.userId),
    ...tenantPolicies('hub_report_subscription_member', table.spaceId),
  ],
)

export const hubReportSubscriptionRecipient = pgTable.withRLS(
  'hub_report_subscription_recipient',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => hubReportSubscription.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('hub_report_subscription_recipient_unique').on(table.subscriptionId, table.userId),
    ...tenantPolicies('hub_report_subscription_recipient', table.spaceId),
  ],
)

export const hubSend = pgTable.withRLS(
  'hub_send',
  {
    id: identity(),
    legacyLocalId: bigint('legacy_local_id', { mode: 'bigint' }),
    spaceId: spaceIdentity(),
    at: timestamp({ withTimezone: true }).notNull(),
    window: text().notNull(),
    recipients: text().notNull(),
    projects: text().notNull(),
    items: integer().notNull(),
    status: text().notNull(),
    error: text(),
    test: integer().notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    machine: text().notNull(),
    subscriptionId: uuid('subscription_id').references(() => hubReportSubscription.id),
    periodStart: timestamp('period_start', { withTimezone: true }),
    periodEnd: timestamp('period_end', { withTimezone: true }),
  },
  (table) => [
    unique('hub_send_space_legacy_unique').on(table.spaceId, table.legacyLocalId),
    uniqueIndex('hub_send_subscription_period_unique')
      .on(table.subscriptionId, table.periodEnd)
      .where(sql`${table.test} = 0`),
    check('hub_send_status_check', sql`${table.status} IN ('pending','sent','skipped','failed')`),
    check(
      'hub_send_subscription_period_check',
      sql`(${table.subscriptionId} IS NULL AND ${table.periodStart} IS NULL AND ${table.periodEnd} IS NULL)
        OR (${table.subscriptionId} IS NOT NULL AND ${table.periodStart} IS NOT NULL AND ${table.periodEnd} IS NOT NULL AND ${table.periodStart} < ${table.periodEnd})`,
    ),
    check('hub_send_test_check', sql`${table.test} IN (0,1)`),
    pgPolicy('hub_send_space_select', {
      for: 'select',
      using: sql`${table.spaceId} = nullif(current_setting('app.space_id', true), '')::uuid
        OR ${table.spaceId} = ANY(
          string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
        )`,
    }),
    pgPolicy('hub_send_space_insert', {
      for: 'insert',
      withCheck: sql`${table.spaceId} = nullif(current_setting('app.space_id', true), '')::uuid`,
    }),
    pgPolicy('hub_send_space_update', {
      for: 'update',
      using: sql`${table.spaceId} = nullif(current_setting('app.space_id', true), '')::uuid`,
      withCheck: sql`${table.spaceId} = nullif(current_setting('app.space_id', true), '')::uuid`,
    }),
  ],
)

export const hubSendRecipient = pgTable.withRLS(
  'hub_send_recipient',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    sendId: uuid('send_id')
      .notNull()
      .references(() => hubSend.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    name: text().notNull(),
    email: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('hub_send_recipient_unique').on(table.sendId, table.userId),
    pgPolicy('hub_send_recipient_space_select', {
      for: 'select',
      using: sql`${table.spaceId} = nullif(current_setting('app.space_id', true), '')::uuid
        OR ${table.spaceId} = ANY(
          string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
        )`,
    }),
    pgPolicy('hub_send_recipient_space_insert', {
      for: 'insert',
      withCheck: sql`${table.spaceId} = nullif(current_setting('app.space_id', true), '')::uuid`,
    }),
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
    userId: uuid('user_id').references(() => user.id),
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
