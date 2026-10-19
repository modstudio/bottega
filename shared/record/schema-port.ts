// concern: postgres-schema-port
/** Knows the hosted port catalogue shapes. Must not know local caches or synchronization. */
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { project, spaceIdentity, tenantPolicies } from './schema.ts'

const identity = () => uuid('id').primaryKey()
const recordedAt = (name: string) => timestamp(name, { withTimezone: true }).notNull()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
const version = () => integer().notNull().default(1)
const sameSpaceIdentity = <
  T extends { spaceId: ReturnType<typeof spaceIdentity>; id: ReturnType<typeof identity> },
>(
  name: string,
  table: T,
) => unique(name).on(table.spaceId, table.id)

export const portDoctrine = pgTable.withRLS(
  'port_doctrine',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    number: integer().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    createdAt: recordedAt('created_at'),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    version: version(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('port_doctrine_number_check', sql`${table.number} > 0`),
    unique('port_doctrine_space_number_unique').on(table.spaceId, table.number),
    index('port_doctrine_space_updated_id_idx').on(table.spaceId, table.updatedAt, table.id),
    ...tenantPolicies('port_doctrine', table.spaceId),
  ],
)

export const portPair = pgTable.withRLS(
  'port_pair',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    sourceProjectId: uuid('source_project_id').notNull(),
    targetProjectId: uuid('target_project_id').notNull(),
    createdAt: recordedAt('created_at'),
  },
  (table) => [
    check(
      'port_pair_distinct_projects_check',
      sql`${table.sourceProjectId} <> ${table.targetProjectId}`,
    ),
    unique('port_pair_space_projects_unique').on(
      table.spaceId,
      table.sourceProjectId,
      table.targetProjectId,
    ),
    sameSpaceIdentity('port_pair_space_id_unique', table),
    index('port_pair_target_idx').on(table.targetProjectId),
    foreignKey({
      columns: [table.sourceProjectId],
      foreignColumns: [project.id],
      name: 'port_pair_source_project_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.spaceId, table.targetProjectId],
      foreignColumns: [project.spaceId, project.id],
      name: 'port_pair_same_space_target_project_fk',
    }).onDelete('restrict'),
    ...tenantPolicies('port_pair', table.spaceId),
  ],
)

export const portBaseline = pgTable.withRLS(
  'port_baseline',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    pairId: uuid('pair_id').notNull(),
    sourceCommit: text('source_commit'),
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    version: version(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      'port_baseline_scan_check',
      sql`(${table.sourceCommit} IS NULL) = (${table.scannedAt} IS NULL)`,
    ),
    unique('port_baseline_space_pair_unique').on(table.spaceId, table.pairId),
    index('port_baseline_space_updated_id_idx').on(table.spaceId, table.updatedAt, table.id),
    foreignKey({
      columns: [table.spaceId, table.pairId],
      foreignColumns: [portPair.spaceId, portPair.id],
      name: 'port_baseline_same_space_pair_fk',
    }).onDelete('cascade'),
    ...tenantPolicies('port_baseline', table.spaceId),
  ],
)

export const portRef = pgTable.withRLS(
  'port_ref',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    taskKey: text('task_key').notNull(),
    targetProjectId: uuid('target_project_id').notNull(),
    note: text().notNull(),
    createdAt: recordedAt('created_at'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    version: version(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('port_ref_space_target_task_unique').on(
      table.spaceId,
      table.targetProjectId,
      table.taskKey,
    ),
    sameSpaceIdentity('port_ref_space_id_unique', table),
    index('port_ref_space_updated_id_idx').on(table.spaceId, table.updatedAt, table.id),
    foreignKey({
      columns: [table.spaceId, table.targetProjectId],
      foreignColumns: [project.spaceId, project.id],
      name: 'port_ref_same_space_target_project_fk',
    }).onDelete('restrict'),
    ...tenantPolicies('port_ref', table.spaceId),
  ],
)

export const portRefSource = pgTable.withRLS(
  'port_ref_source',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    refId: uuid('ref_id').notNull(),
    sourceProjectId: uuid('source_project_id').notNull(),
    commits: text().notNull(),
    paths: text().notNull(),
    note: text().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique('port_ref_source_space_ref_source_unique').on(
      table.spaceId,
      table.refId,
      table.sourceProjectId,
    ),
    sameSpaceIdentity('port_ref_source_space_id_unique', table),
    index('port_ref_source_space_updated_id_idx').on(table.spaceId, table.updatedAt, table.id),
    foreignKey({
      columns: [table.spaceId, table.refId],
      foreignColumns: [portRef.spaceId, portRef.id],
      name: 'port_ref_source_same_space_ref_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.sourceProjectId],
      foreignColumns: [project.id],
      name: 'port_ref_source_source_project_fk',
    }).onDelete('restrict'),
    ...tenantPolicies('port_ref_source', table.spaceId),
  ],
)

export const portSkip = pgTable.withRLS(
  'port_skip',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    pairId: uuid('pair_id').notNull(),
    candidate: text().notNull(),
    reason: text().notNull(),
    skippedAt: recordedAt('skipped_at'),
  },
  (table) => [
    unique('port_skip_space_pair_candidate_unique').on(
      table.spaceId,
      table.pairId,
      table.candidate,
    ),
    index('port_skip_pair_idx').on(table.pairId),
    foreignKey({
      columns: [table.spaceId, table.pairId],
      foreignColumns: [portPair.spaceId, portPair.id],
      name: 'port_skip_same_space_pair_fk',
    }).onDelete('cascade'),
    ...tenantPolicies('port_skip', table.spaceId),
  ],
)
