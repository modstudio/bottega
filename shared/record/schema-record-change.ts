// concern: postgres-schema-record-change
/** Knows the ordered hosted replication log shape. Must not know feed transport or local caches. */
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { RECORD_ACTOR_ROLE, RECORD_OWNER_ROLE, space, user } from './schema.ts'

const xid8 = customType<{ data: string }>({ dataType: () => 'xid8' })
const currentSpace = sql`nullif(current_setting('app.space_id', true), '')::uuid`
const readableSpaces = sql`string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]`

export const RECORD_CHANGE_CHILD_TABLES = [
  ['doc_related_subject', 'doc_id', 'doc'],
  ['hub_send_recipient', 'send_id', 'hub_send'],
  ['review_lens', 'run_id', 'run'],
  ['run_exclusion', 'run_id', 'run'],
] as const

export const RECORD_CHANGE_EXCLUDED_TABLES = {
  hub_interval: 'no feed serves this table; the working-set slice decides its sync',
  hub_day: 'no feed serves this table; the working-set slice decides its sync',
  doc_revision: 'doc history stays hosted-only',
  hub_report_subscription: 'hosted report configuration is not replicated to a working set',
  hub_report_subscription_member: 'hosted report membership is not replicated to a working set',
  hub_report_subscription_project: 'hosted report selection is not replicated to a working set',
  hub_report_subscription_recipient: 'hosted report recipients are not replicated to a working set',
} as const

export const RECORD_CHANGE_TRIGGER_TABLES = [
  'hub_task',
  'hub_task_comment',
  'hub_task_document',
  'hub_task_status_event',
  'hub_send',
  'hub_note',
  'hub_note_acknowledgement',
  'hub_send_recipient',
  'doc',
  'doc_related_subject',
  'subject',
  'project',
  'lens',
  'lens_revision',
  'lens_profile',
  'lens_profile_revision',
  'project_lens_profile',
  'project_lens_profile_revision',
  'port_doctrine',
  'port_pair',
  'port_baseline',
  'port_ref',
  'port_ref_source',
  'port_skip',
  'workflow',
  'workflow_version',
  'workflow_event',
  'step_catalogue',
  'step_catalogue_version',
  'step_catalogue_event',
  'run',
  'review_lens',
  'run_exclusion',
  'run_score',
] as const

const recordChangeChildTables = new Set<string>(RECORD_CHANGE_CHILD_TABLES.map(([table]) => table))
export const RECORD_CHANGE_LOGGED_TABLES = RECORD_CHANGE_TRIGGER_TABLES.filter(
  (table) => !recordChangeChildTables.has(table),
)

export const recordChange = pgTable.withRLS(
  'record_change',
  {
    id: uuid().primaryKey().default(sql`public.record_uuid_v7()`),
    seq: bigint({ mode: 'bigint' }).notNull().unique().generatedAlwaysAsIdentity(),
    xid: xid8().notNull().default(sql`pg_current_xact_id()`),
    spaceId: uuid('space_id').references(() => space.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'cascade' }),
    tableName: text('table_name').notNull(),
    rowId: uuid('row_id').notNull(),
    op: text().notNull(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  // Triggers insert change rows inside a statement whose row policy already judged the caller.
  (table) => [
    check(
      'record_change_attribution_check',
      sql`num_nonnulls(${table.spaceId}, ${table.userId}) = 1`,
    ),
    check('record_change_op_check', sql`${table.op} IN ('upsert','delete')`),
    index('record_change_space_seq_idx').on(table.spaceId, table.seq),
    index('record_change_xid_seq_idx').on(table.xid, table.seq),
    pgPolicy('record_change_space_select', {
      for: 'select',
      to: RECORD_ACTOR_ROLE,
      using: sql`${table.spaceId} = ${currentSpace} OR ${table.spaceId} = ANY(${readableSpaces})`,
    }),
    pgPolicy('record_change_space_insert', {
      for: 'insert',
      to: RECORD_ACTOR_ROLE,
      withCheck: sql`${table.spaceId} = ${currentSpace}`,
    }),
    pgPolicy('record_change_owner_all', {
      for: 'all',
      to: RECORD_OWNER_ROLE,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
)

export const recordChangeHorizon = pgTable.withRLS(
  'record_change_horizon',
  {
    id: uuid().primaryKey().default(sql`public.record_uuid_v7()`),
    singleton: boolean().notNull().unique().default(true),
    xid: xid8().notNull().default(sql`'0'::xid8`),
    seq: bigint({ mode: 'bigint' }).notNull().default(0n),
  },
  (table) => [
    check('record_change_horizon_singleton_check', sql`${table.singleton}`),
    pgPolicy('record_change_horizon_actor_select', {
      for: 'select',
      to: RECORD_ACTOR_ROLE,
      using: sql`true`,
    }),
    pgPolicy('record_change_horizon_owner_all', {
      for: 'all',
      to: RECORD_OWNER_ROLE,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
)
