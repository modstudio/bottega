// concern: postgres-schema-workflow-catalogue
/** Knows the hosted workflow catalogue shapes. Must not know local caches or synchronization. */
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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { spaceIdentity, tenantPolicies } from './schema.ts'

const identity = () => uuid('id').primaryKey()
const recordedAt = (name: string) => timestamp(name, { withTimezone: true }).notNull()
const sameSpaceIdentity = <
  T extends { spaceId: ReturnType<typeof spaceIdentity>; id: ReturnType<typeof identity> },
>(
  name: string,
  table: T,
) => unique(name).on(table.spaceId, table.id)

export const workflow = pgTable.withRLS(
  'workflow',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    slug: text().notNull(),
    createdAt: recordedAt('created_at'),
  },
  (table) => [
    unique('workflow_space_slug_unique').on(table.spaceId, table.slug),
    sameSpaceIdentity('workflow_space_id_unique', table),
    ...tenantPolicies('workflow', table.spaceId),
  ],
)

export const workflowVersion = pgTable.withRLS(
  'workflow_version',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    workflowId: uuid('workflow_id').notNull(),
    n: integer().notNull(),
    status: text().notNull(),
    definition: text().notNull(),
    author: text().notNull(),
    reason: text().notNull(),
    createdAt: recordedAt('created_at'),
    promotedAt: timestamp('promoted_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => [
    check('workflow_version_n_check', sql`${table.n} > 0`),
    check(
      'workflow_version_status_check',
      sql`${table.status} IN ('draft','production','retired')`,
    ),
    check('workflow_version_author_check', sql`length(trim(${table.author})) > 0`),
    check('workflow_version_reason_check', sql`length(trim(${table.reason})) > 0`),
    unique('workflow_version_workflow_n_unique').on(table.workflowId, table.n),
    uniqueIndex('workflow_version_one_production')
      .on(table.workflowId)
      .where(sql`${table.status} = 'production'`),
    sameSpaceIdentity('workflow_version_space_id_unique', table),
    foreignKey({
      columns: [table.spaceId, table.workflowId],
      foreignColumns: [workflow.spaceId, workflow.id],
      name: 'workflow_version_same_space_fk',
    }).onDelete('cascade'),
    ...tenantPolicies('workflow_version', table.spaceId),
  ],
)

export const workflowEvent = pgTable.withRLS(
  'workflow_event',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    workflowVersionId: uuid('workflow_version_id').notNull(),
    event: text().notNull(),
    author: text().notNull(),
    reason: text().notNull(),
    sessionId: text('session_id'),
    at: recordedAt('at'),
  },
  (table) => [
    check(
      'workflow_event_event_check',
      sql`${table.event} IN ('set','fork','import','promote','retire')`,
    ),
    check('workflow_event_author_check', sql`length(trim(${table.author})) > 0`),
    check('workflow_event_reason_check', sql`length(trim(${table.reason})) > 0`),
    index('workflow_event_version_idx').on(table.workflowVersionId, table.id),
    foreignKey({
      columns: [table.spaceId, table.workflowVersionId],
      foreignColumns: [workflowVersion.spaceId, workflowVersion.id],
      name: 'workflow_event_same_space_fk',
    }).onDelete('cascade'),
    ...tenantPolicies('workflow_event', table.spaceId),
  ],
)

export const stepCatalogue = pgTable.withRLS(
  'step_catalogue',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    slug: text().notNull(),
    createdAt: recordedAt('created_at'),
  },
  (table) => [
    unique('step_catalogue_space_slug_unique').on(table.spaceId, table.slug),
    sameSpaceIdentity('step_catalogue_space_id_unique', table),
    ...tenantPolicies('step_catalogue', table.spaceId),
  ],
)

export const stepCatalogueVersion = pgTable.withRLS(
  'step_catalogue_version',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    catalogueId: uuid('catalogue_id').notNull(),
    n: integer().notNull(),
    status: text().notNull(),
    definition: text().notNull(),
    author: text().notNull(),
    reason: text().notNull(),
    createdAt: recordedAt('created_at'),
    promotedAt: timestamp('promoted_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => [
    check('step_catalogue_version_n_check', sql`${table.n} > 0`),
    check(
      'step_catalogue_version_status_check',
      sql`${table.status} IN ('draft','production','retired')`,
    ),
    check('step_catalogue_version_author_check', sql`length(trim(${table.author})) > 0`),
    check('step_catalogue_version_reason_check', sql`length(trim(${table.reason})) > 0`),
    unique('step_catalogue_version_catalogue_n_unique').on(table.catalogueId, table.n),
    uniqueIndex('step_catalogue_version_one_production')
      .on(table.catalogueId)
      .where(sql`${table.status} = 'production'`),
    sameSpaceIdentity('step_catalogue_version_space_id_unique', table),
    foreignKey({
      columns: [table.spaceId, table.catalogueId],
      foreignColumns: [stepCatalogue.spaceId, stepCatalogue.id],
      name: 'step_catalogue_version_same_space_fk',
    }).onDelete('cascade'),
    ...tenantPolicies('step_catalogue_version', table.spaceId),
  ],
)

export const stepCatalogueEvent = pgTable.withRLS(
  'step_catalogue_event',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    catalogueVersionId: uuid('catalogue_version_id').notNull(),
    event: text().notNull(),
    author: text().notNull(),
    reason: text().notNull(),
    sessionId: text('session_id'),
    at: recordedAt('at'),
  },
  (table) => [
    check(
      'step_catalogue_event_event_check',
      sql`${table.event} IN ('set','fork','import','promote','retire')`,
    ),
    check('step_catalogue_event_author_check', sql`length(trim(${table.author})) > 0`),
    check('step_catalogue_event_reason_check', sql`length(trim(${table.reason})) > 0`),
    index('step_catalogue_event_version_idx').on(table.catalogueVersionId, table.id),
    foreignKey({
      columns: [table.spaceId, table.catalogueVersionId],
      foreignColumns: [stepCatalogueVersion.spaceId, stepCatalogueVersion.id],
      name: 'step_catalogue_event_same_space_fk',
    }).onDelete('cascade'),
    ...tenantPolicies('step_catalogue_event', table.spaceId),
  ],
)
