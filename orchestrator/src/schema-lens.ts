// concern: schema-lens
import { sql } from 'drizzle-orm'
import { check, integer, sqliteTable, text, unique, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { id, project } from './schema-core.ts'

export const lens = sqliteTable(
  'lens',
  {
    id: text().primaryKey(),
    title: text().notNull(),
    question: text().notNull(),
    excludes: text().notNull(),
    slots: text().notNull(),
    version: integer().notNull(),
    enabled: integer().notNull().default(1),
  },
  (t) => [
    check('lens_version_check', sql`${t.version} > 0`),
    check('lens_enabled_check', sql`${t.enabled} in (0,1)`),
  ],
)

export const lensRevision = sqliteTable(
  'lens_revision',
  {
    id: id(),
    lensId: text('lens_id')
      .notNull()
      .references(() => lens.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    priorBody: text('prior_body').notNull(),
    reason: text().notNull(),
    sessionId: text('session_id'),
    at: text().notNull(),
  },
  (t) => [
    unique('lens_revision_lens_version_unique').on(t.lensId, t.version),
    check('lens_revision_reason_check', sql`length(trim(${t.reason})) > 0`),
  ],
)

export const lensProfile = sqliteTable(
  'lens_profile',
  {
    id: id(),
    lensId: text('lens_id')
      .notNull()
      .references(() => lens.id, { onDelete: 'cascade' }),
    axis: text().notNull(),
    name: text().notNull(),
    version: integer().notNull(),
    body: text().notNull(),
    enabled: integer().notNull().default(1),
  },
  (t) => [
    check('lens_profile_axis_check', sql`${t.axis} in ('framework','architecture')`),
    check('lens_profile_version_check', sql`${t.version} > 0`),
    check('lens_profile_enabled_check', sql`${t.enabled} in (0,1)`),
    unique('lens_profile_lens_axis_name_unique').on(t.lensId, t.axis, t.name),
  ],
)

export const lensProfileRevision = sqliteTable(
  'lens_profile_revision',
  {
    id: id(),
    profileId: integer('profile_id')
      .notNull()
      .references(() => lensProfile.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    priorBody: text('prior_body').notNull(),
    reason: text().notNull(),
    sessionId: text('session_id'),
    at: text().notNull(),
  },
  (t) => [
    unique('lens_profile_revision_profile_version_unique').on(t.profileId, t.version),
    check('lens_profile_revision_reason_check', sql`length(trim(${t.reason})) > 0`),
  ],
)

export const projectLensProfile = sqliteTable(
  'project_lens_profile',
  {
    id: id(),
    projectId: integer('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    lensId: text('lens_id').references(() => lens.id, { onDelete: 'cascade' }),
    axis: text().notNull(),
    profileName: text('profile_name').notNull(),
    selectedVersion: integer('selected_version'),
  },
  (t) => [
    check('project_lens_profile_axis_check', sql`${t.axis} in ('framework','architecture')`),
    check(
      'project_lens_profile_version_check',
      sql`${t.selectedVersion} is null or ${t.selectedVersion} > 0`,
    ),
    uniqueIndex('project_lens_profile_specific')
      .on(t.projectId, t.lensId, t.axis)
      .where(sql`${t.lensId} is not null`),
    uniqueIndex('project_lens_profile_global')
      .on(t.projectId, t.axis)
      .where(sql`${t.lensId} is null`),
  ],
)

export const projectLensProfileRevision = sqliteTable(
  'project_lens_profile_revision',
  {
    id: id(),
    selectionId: integer('selection_id')
      .notNull()
      .references(() => projectLensProfile.id, { onDelete: 'cascade' }),
    priorProfileName: text('prior_profile_name'),
    priorSelectedVersion: integer('prior_selected_version'),
    reason: text().notNull(),
    sessionId: text('session_id'),
    at: text().notNull(),
  },
  (t) => [
    check(
      'project_lens_profile_revision_version_check',
      sql`${t.priorSelectedVersion} is null or ${t.priorSelectedVersion} > 0`,
    ),
    check('project_lens_profile_revision_reason_check', sql`length(trim(${t.reason})) > 0`),
  ],
)
