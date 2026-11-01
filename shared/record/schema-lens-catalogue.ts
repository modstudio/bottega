// concern: postgres-schema-lens-catalogue
/** Knows the hosted lens catalogue shapes. Must not know local caches or synchronization. */
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
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
import { project, spaceIdentity, tenantPolicies } from './schema.ts'

const identity = () => uuid('id').primaryKey()
const recordedAt = (name: string) => timestamp(name, { withTimezone: true }).notNull()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
const sameSpaceIdentity = (name: string, table: { spaceId: AnyPgColumn; id: AnyPgColumn }) =>
  unique(name).on(table.spaceId, table.id)

export const lens = pgTable.withRLS(
  'lens',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    key: text().notNull(),
    title: text().notNull(),
    question: text().notNull(),
    excludes: text().notNull(),
    slots: text().notNull(),
    version: integer().notNull(),
    enabled: boolean().notNull().default(true),
    requiresExecution: boolean('requires_execution').notNull().default(false),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('lens_version_check', sql`${table.version} > 0`),
    unique('lens_space_key_unique').on(table.spaceId, table.key),
    sameSpaceIdentity('lens_space_id_unique', table),
    index('lens_space_updated_id_idx').on(table.spaceId, table.updatedAt, table.id),
    ...tenantPolicies('lens', table.spaceId),
  ],
)

export const lensRevision = pgTable.withRLS(
  'lens_revision',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    lensId: uuid('lens_id').notNull(),
    version: integer().notNull(),
    priorBody: text('prior_body').notNull(),
    reason: text().notNull(),
    sessionId: text('session_id'),
    at: recordedAt('at'),
  },
  (table) => [
    check('lens_revision_version_check', sql`${table.version} > 0`),
    check('lens_revision_reason_check', sql`length(trim(${table.reason})) > 0`),
    unique('lens_revision_lens_version_unique').on(table.lensId, table.version),
    foreignKey({
      columns: [table.spaceId, table.lensId],
      foreignColumns: [lens.spaceId, lens.id],
      name: 'lens_revision_same_space_fk',
    }).onDelete('cascade'),
    ...tenantPolicies('lens_revision', table.spaceId),
  ],
)

export const lensProfile = pgTable.withRLS(
  'lens_profile',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    lensId: uuid('lens_id').notNull(),
    axis: text().notNull(),
    name: text().notNull(),
    version: integer().notNull(),
    currentVersionId: uuid('current_version_id').default(sql`public.record_uuid_v7()`),
    body: text().notNull(),
    enabled: boolean().notNull().default(true),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('lens_profile_axis_check', sql`${table.axis} IN ('framework','architecture')`),
    check('lens_profile_version_check', sql`${table.version} > 0`),
    unique('lens_profile_space_lens_axis_name_unique').on(
      table.spaceId,
      table.lensId,
      table.axis,
      table.name,
    ),
    sameSpaceIdentity('lens_profile_space_id_unique', table),
    index('lens_profile_space_updated_id_idx').on(table.spaceId, table.updatedAt, table.id),
    foreignKey({
      columns: [table.spaceId, table.lensId],
      foreignColumns: [lens.spaceId, lens.id],
      name: 'lens_profile_same_space_fk',
    }).onDelete('cascade'),
    ...tenantPolicies('lens_profile', table.spaceId),
  ],
)

export const lensProfileRevision = pgTable.withRLS(
  'lens_profile_revision',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    profileId: uuid('profile_id').notNull(),
    version: integer().notNull(),
    priorBody: text('prior_body').notNull(),
    reason: text().notNull(),
    sessionId: text('session_id'),
    at: recordedAt('at'),
  },
  (table) => [
    check('lens_profile_revision_version_check', sql`${table.version} > 0`),
    check('lens_profile_revision_reason_check', sql`length(trim(${table.reason})) > 0`),
    unique('lens_profile_revision_profile_version_unique').on(table.profileId, table.version),
    foreignKey({
      columns: [table.spaceId, table.profileId],
      foreignColumns: [lensProfile.spaceId, lensProfile.id],
      name: 'lens_profile_revision_same_space_fk',
    }).onDelete('cascade'),
    ...tenantPolicies('lens_profile_revision', table.spaceId),
  ],
)

export const projectLensProfile = pgTable.withRLS(
  'project_lens_profile',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    projectId: uuid('project_id').notNull(),
    lensId: uuid('lens_id'),
    axis: text().notNull(),
    profileName: text('profile_name').notNull(),
    selectedVersion: integer('selected_version'),
    selectedVersionId: uuid('selected_version_id'),
    selectionVersion: integer('selection_version').notNull().default(1),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('project_lens_profile_axis_check', sql`${table.axis} IN ('framework','architecture')`),
    check(
      'project_lens_profile_selected_version_check',
      sql`${table.selectedVersion} IS NULL OR ${table.selectedVersion} > 0`,
    ),
    check('project_lens_profile_selection_version_check', sql`${table.selectionVersion} > 0`),
    uniqueIndex('project_lens_profile_specific')
      .on(table.spaceId, table.projectId, table.lensId, table.axis)
      .where(sql`${table.lensId} IS NOT NULL`),
    uniqueIndex('project_lens_profile_global')
      .on(table.spaceId, table.projectId, table.axis)
      .where(sql`${table.lensId} IS NULL`),
    sameSpaceIdentity('project_lens_profile_space_id_unique', table),
    index('project_lens_profile_space_updated_id_idx').on(table.spaceId, table.updatedAt, table.id),
    foreignKey({
      columns: [table.spaceId, table.projectId],
      foreignColumns: [project.spaceId, project.id],
      name: 'project_lens_profile_same_space_project_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.spaceId, table.lensId],
      foreignColumns: [lens.spaceId, lens.id],
      name: 'project_lens_profile_same_space_lens_fk',
    }).onDelete('cascade'),
    ...tenantPolicies('project_lens_profile', table.spaceId),
  ],
)

export const projectLensProfileRevision = pgTable.withRLS(
  'project_lens_profile_revision',
  {
    id: identity(),
    spaceId: spaceIdentity(),
    selectionId: uuid('selection_id').notNull(),
    priorProfileName: text('prior_profile_name'),
    priorSelectedVersion: integer('prior_selected_version'),
    priorSelectedVersionId: uuid('prior_selected_version_id'),
    reason: text().notNull(),
    sessionId: text('session_id'),
    at: recordedAt('at'),
  },
  (table) => [
    check(
      'project_lens_profile_revision_selected_version_check',
      sql`${table.priorSelectedVersion} IS NULL OR ${table.priorSelectedVersion} > 0`,
    ),
    check('project_lens_profile_revision_reason_check', sql`length(trim(${table.reason})) > 0`),
    foreignKey({
      columns: [table.spaceId, table.selectionId],
      foreignColumns: [projectLensProfile.spaceId, projectLensProfile.id],
      name: 'project_lens_profile_revision_same_space_fk',
    }).onDelete('cascade'),
    ...tenantPolicies('project_lens_profile_revision', table.spaceId),
  ],
)
