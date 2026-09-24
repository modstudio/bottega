// concern: postgres-schema-docs
/** Knows the hosted operator-document record shape. Must not know local cache or synchronization. */
import { sql } from 'drizzle-orm'
import { check, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { project, spaceIdentity, tenantPolicies, user } from './schema.ts'

const recordIdentity = () => uuid().primaryKey()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull()
const currentUser = sql`nullif(current_setting('app.user_id', true), '')::uuid`
const ownerPolicies = (table: string, owner: ReturnType<typeof uuid>) => [
  pgPolicy(`${table}_owner_select`, {
    as: 'restrictive',
    for: 'select',
    using: sql`${owner} IS NULL OR ${owner} = ${currentUser}`,
  }),
  pgPolicy(`${table}_owner_insert`, {
    as: 'restrictive',
    for: 'insert',
    withCheck: sql`${owner} IS NULL OR ${owner} = ${currentUser}`,
  }),
  pgPolicy(`${table}_owner_update`, {
    as: 'restrictive',
    for: 'update',
    using: sql`${owner} IS NULL OR ${owner} = ${currentUser}`,
    withCheck: sql`${owner} IS NULL OR ${owner} = ${currentUser}`,
  }),
  pgPolicy(`${table}_owner_delete`, {
    as: 'restrictive',
    for: 'delete',
    using: sql`${owner} IS NULL OR ${owner} = ${currentUser}`,
  }),
]

const subjectRule = (
  scope: ReturnType<typeof text>,
  subject: ReturnType<typeof text>,
  owner: ReturnType<typeof uuid>,
) => sql`(
  (${owner} IS NOT NULL AND ${scope} = 'canon' AND ${subject} IS NULL) OR
  (${owner} IS NULL AND (
  (${scope} IN ('machine','global') AND ${subject} IS NULL) OR
  (${scope} IN ('project','stack','agent','job','resume') AND ${subject} IS NOT NULL) OR
  ${scope} = 'canon'
  ))
)`
const slugRule = (scope: ReturnType<typeof text>, slug: ReturnType<typeof text>) => sql`(
  (${scope} = 'canon' AND length(${slug}) > 0 AND ${slug} NOT LIKE '/%' AND ${slug} NOT LIKE '%..%') OR
  (${scope} <> 'canon' AND length(${slug}) <= 64 AND ${slug} ~ '^[a-z0-9][a-z0-9-]*$')
)`

export const doc = pgTable.withRLS(
  'doc',
  {
    id: recordIdentity(),
    spaceId: spaceIdentity(),
    scope: text().notNull(),
    subject: text(),
    ownerUserId: uuid('owner_user_id').references(() => user.id),
    slug: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    delivery: text().notNull(),
    projectId: uuid('project_id').references(() => project.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    latestRevisionId: uuid('latest_revision_id'),
  },
  (table) => [
    check(
      'doc_scope_check',
      sql`${table.scope} IN ('project','machine','agent','job','global','stack','resume','canon')`,
    ),
    check('doc_delivery_check', sql`${table.delivery} IN ('inject','demand')`),
    check('doc_subject_check', subjectRule(table.scope, table.subject, table.ownerUserId)),
    check('doc_slug_check', slugRule(table.scope, table.slug)),
    uniqueIndex('doc_live_address')
      .on(
        table.spaceId,
        table.scope,
        sql`COALESCE(${table.subject}, '')`,
        sql`COALESCE(${table.ownerUserId}::text, '')`,
        table.slug,
      )
      .where(sql`${table.deletedAt} IS NULL`),
    uniqueIndex('doc_updated_at').on(table.spaceId, table.updatedAt, table.id),
    ...tenantPolicies('doc', table.spaceId),
    ...ownerPolicies('doc', table.ownerUserId),
  ],
)

export const docRevision = pgTable.withRLS(
  'doc_revision',
  {
    id: recordIdentity(),
    spaceId: spaceIdentity(),
    docId: uuid('doc_id').notNull(),
    scope: text().notNull(),
    subject: text(),
    ownerUserId: uuid('owner_user_id').references(() => user.id),
    slug: text().notNull(),
    projectId: uuid('project_id').references(() => project.id),
    op: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    delivery: text().notNull(),
    author: text().notNull(),
    reason: text().notNull(),
    sessionId: text('session_id'),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      'doc_revision_scope_check',
      sql`${table.scope} IN ('project','machine','agent','job','global','stack','resume','canon')`,
    ),
    check('doc_revision_delivery_check', sql`${table.delivery} IN ('inject','demand')`),
    check(
      'doc_revision_op_check',
      sql`${table.op} IN ('create','set','consume','delete','restore','import','backfill')`,
    ),
    check('doc_revision_subject_check', subjectRule(table.scope, table.subject, table.ownerUserId)),
    check('doc_revision_slug_check', slugRule(table.scope, table.slug)),
    check('doc_revision_author_check', sql`length(trim(${table.author})) > 0`),
    check('doc_revision_reason_check', sql`length(trim(${table.reason})) > 0`),
    uniqueIndex('doc_revision_identity').on(
      table.spaceId,
      table.docId,
      table.at,
      table.op,
      table.author,
      table.reason,
    ),
    ...tenantPolicies('doc_revision', table.spaceId),
    ...ownerPolicies('doc_revision', table.ownerUserId),
  ],
)
