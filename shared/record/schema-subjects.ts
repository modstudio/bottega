// concern: postgres-schema-subjects
/** Knows the hosted project-subject record shape. Must not know local cache or synchronization. */
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { project, spaceIdentity, tenantPolicies } from './schema.ts'

export const subject = pgTable.withRLS(
  'subject',
  {
    id: uuid().primaryKey(),
    spaceId: spaceIdentity(),
    projectId: uuid('project_id').notNull(),
    name: text().notNull(),
    definition: text().notNull(),
    position: integer().notNull(),
    parentId: uuid('parent_id'),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check('subject_name_check', sql`length(trim(${table.name})) > 0`),
    check(
      'subject_definition_check',
      sql`length(trim(${table.definition})) > 0 AND position(E'\\n' in ${table.definition}) = 0 AND position(E'\\r' in ${table.definition}) = 0`,
    ),
    check('subject_position_check', sql`${table.position} >= 0`),
    check(
      'subject_parent_check',
      sql`${table.parentId} IS NULL OR ${table.parentId} <> ${table.id}`,
    ),
    uniqueIndex('subject_space_project_id_unique').on(table.spaceId, table.projectId, table.id),
    uniqueIndex('subject_live_name')
      .on(table.spaceId, table.projectId, table.name)
      .where(sql`${table.retiredAt} IS NULL`),
    index('subject_project_position').on(table.spaceId, table.projectId, table.position, table.id),
    foreignKey({
      columns: [table.spaceId, table.projectId],
      foreignColumns: [project.spaceId, project.id],
      name: 'subject_space_project_fk',
    }).onUpdate('cascade'),
    foreignKey({
      columns: [table.spaceId, table.projectId, table.parentId],
      foreignColumns: [table.spaceId, table.projectId, table.id],
      name: 'subject_parent_same_project_fk',
    }),
    ...tenantPolicies('subject', table.spaceId),
  ],
)
