// concern: schema-workflow
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { EVENT_KINDS, RESOURCE_KINDS } from './contention.ts'
import { MONITOR_SEVERITY } from './review-vocabulary.ts'
import { id, values } from './schema-core.ts'

export const workflow = sqliteTable('workflow', {
  id: id(),
  slug: text().notNull().unique(),
  createdAt: text('created_at').notNull(),
})

export const workflowVersion = sqliteTable(
  'workflow_version',
  {
    id: id(),
    workflowId: integer('workflow_id')
      .notNull()
      .references(() => workflow.id, { onDelete: 'cascade' }),
    n: integer().notNull(),
    status: text().notNull(),
    definition: text().notNull(),
    author: text().notNull(),
    reason: text().notNull(),
    createdAt: text('created_at').notNull(),
    promotedAt: text('promoted_at'),
    retiredAt: text('retired_at'),
  },
  (t) => [
    check('workflow_version_status_check', sql`${t.status} in ('draft','production','retired')`),
    check('workflow_version_author_check', sql`length(trim(${t.author})) > 0`),
    check('workflow_version_reason_check', sql`length(trim(${t.reason})) > 0`),
    unique('workflow_version_workflow_n_unique').on(t.workflowId, t.n),
    uniqueIndex('workflow_one_production').on(t.workflowId).where(sql`${t.status} = 'production'`),
    index('workflow_version_workflow').on(t.workflowId, t.n),
  ],
)

export const workflowEvent = sqliteTable(
  'workflow_event',
  {
    id: id(),
    workflowId: integer('workflow_id').notNull(),
    versionN: integer('version_n').notNull(),
    event: text().notNull(),
    author: text().notNull(),
    reason: text().notNull(),
    sessionId: text('session_id'),
    at: text().notNull(),
  },
  (t) => [
    check(
      'workflow_event_event_check',
      sql`${t.event} in ('set','fork','import','promote','retire')`,
    ),
    check('workflow_event_author_check', sql`length(trim(${t.author})) > 0`),
    check('workflow_event_reason_check', sql`length(trim(${t.reason})) > 0`),
    foreignKey({
      columns: [t.workflowId, t.versionN],
      foreignColumns: [workflowVersion.workflowId, workflowVersion.n],
    }),
    index('workflow_event_version').on(t.workflowId, t.versionN, t.id),
  ],
)

export const monitorInvocation = sqliteTable(
  'monitor_invocation',
  {
    id: id(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    trigger: text().notNull(),
    findings: integer(),
    errors: integer(),
  },
  (t) => [check('monitor_invocation_trigger_check', sql`${t.trigger} in ('invoked','backstop')`)],
)

export const monitorCondition = sqliteTable(
  'monitor_condition',
  {
    id: id(),
    invocationId: integer('invocation_id')
      .notNull()
      .references(() => monitorInvocation.id, { onDelete: 'cascade' }),
    kind: text().notNull(),
    subject: text().notNull(),
    conditionSince: text('condition_since'),
    ageMs: integer('age_ms'),
    detail: text().notNull(),
    action: text().notNull(),
    issueKey: text('issue_key'),
    severity: text(),
    ownerSessionId: text('owner_session_id'),
    deliveredAt: text('delivered_at'),
  },
  (t) => [
    check(
      'monitor_condition_severity_check',
      sql`${t.severity} is null or ${t.severity} in (${values(MONITOR_SEVERITY)})`,
    ),
    unique('monitor_condition_invocation_kind_subject_unique').on(
      t.invocationId,
      t.kind,
      t.subject,
    ),
    index('monitor_condition_kind').on(t.kind, t.invocationId),
    index('monitor_condition_owner_delivery').on(t.ownerSessionId, t.deliveredAt),
    index('monitor_condition_latest').on(
      t.ownerSessionId,
      t.kind,
      t.subject,
      t.conditionSince,
      t.id,
    ),
  ],
)

export const contention = sqliteTable(
  'contention',
  {
    id: id(),
    recordId: text('record_id').unique(),
    at: text().notNull(),
    sessionId: text('session_id'),
    resourceKind: text('resource_kind').notNull(),
    resourceKey: text('resource_key').notNull(),
    eventKind: text('event_kind').notNull(),
    durationMs: integer('duration_ms'),
    cause: text(),
    runId: integer('run_id'),
    landingId: integer('landing_id'),
  },
  (t) => [
    check('contention_resource_kind_check', sql`${t.resourceKind} in (${values(RESOURCE_KINDS)})`),
    check('contention_event_kind_check', sql`${t.eventKind} in (${values(EVENT_KINDS)})`),
    index('contention_kind_at').on(t.resourceKind, t.at),
    index('contention_session_at').on(t.sessionId, t.at),
    index('contention_landing').on(t.landingId),
  ],
)

export const testFlake = sqliteTable(
  'test_flake',
  {
    id: id(),
    recordId: text('record_id').unique(),
    test: text().notNull(),
    file: text().notNull(),
    loadAtFailure: text('load_at_failure').notNull(),
    signal: text(),
    at: text().notNull(),
  },
  (t) => [
    check('test_flake_load_json_check', sql`json_valid(${t.loadAtFailure})`),
    index('test_flake_test_file_at').on(t.test, t.file, t.at),
  ],
)
