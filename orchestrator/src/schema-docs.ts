// concern: schema-docs
import { sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core'
import { DOC_SCOPE_SUBJECT_KIND, DOC_SCOPES } from '../../shared/docs.ts'
import { id, project, run, subjectlessScopes, subjectScopes, values } from './schema-core.ts'

const docAddressChecks = <
  T extends { scope: AnySQLiteColumn; subject: AnySQLiteColumn; slug: AnySQLiteColumn },
>(
  t: T,
) => [
  check('scope_check', sql`${t.scope} in (${values(DOC_SCOPES)})`),
  check(
    'slug_check',
    sql`length(${t.slug}) <= 64 and ${t.slug} glob '[a-z0-9]*' and ${t.slug} not glob '*[^a-z0-9-]*'`,
  ),
  check(
    'subject_check',
    sql`(${t.scope} in (${values(subjectlessScopes)}) and ${t.subject} is null) or (${t.scope} in (${values(subjectScopes)}) and ${t.subject} is not null)`,
  ),
]

// migrations/0000_bright_sleepwalker.sql owns doc_address: Drizzle Kit 0.31.10 cannot express
// COALESCE in an index without emitting malformed SQL.
export const doc = sqliteTable(
  'doc',
  {
    id: integer().primaryKey(),
    scope: text().notNull(),
    /** @deprecated Project-scope mirror; use projectId. */ subject: text(),
    slug: text().notNull(),
    title: text().notNull(),
    projectId: integer('project_id').references(() => project.id, { onDelete: 'restrict' }),
    body: text().notNull(),
    delivery: text().notNull().default('inject'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    ...docAddressChecks(t),
    check('doc_delivery_check', sql`${t.delivery} in ('inject','demand')`),
    unique('doc_scope_subject_slug_unique').on(t.scope, t.subject, t.slug),
    index('doc_scope_subject').on(t.scope, t.subject),
  ],
)

export const docRevision = sqliteTable(
  'doc_revision',
  {
    id: integer().primaryKey(),
    docId: integer('doc_id').notNull(),
    scope: text().notNull(),
    /** @deprecated Project-scope mirror; use projectId. */ subject: text(),
    slug: text().notNull(),
    projectId: integer('project_id').references(() => project.id, { onDelete: 'restrict' }),
    op: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    delivery: text().notNull().default('inject'),
    author: text().notNull(),
    reason: text().notNull(),
    sessionId: text('session_id'),
    at: text().notNull(),
  },
  (t) => [
    ...docAddressChecks(t),
    check(
      'doc_revision_op_check',
      sql`${t.op} in ('create','set','consume','delete','restore','import','backfill')`,
    ),
    check('doc_revision_delivery_check', sql`${t.delivery} in ('inject','demand')`),
    check('doc_revision_author_check', sql`length(trim(${t.author})) > 0`),
    check('doc_revision_reason_check', sql`length(trim(${t.reason})) > 0`),
    index('doc_revision_doc').on(t.docId, t.id),
    index('doc_revision_address').on(t.scope, t.subject, t.slug, t.id),
  ],
)

// migrations/0000_bright_sleepwalker.sql owns canon_pack_address: Drizzle Kit 0.31.10 cannot express
// COALESCE in an index without emitting malformed SQL.
export const canonPack = sqliteTable(
  'canon_pack',
  {
    id: integer().primaryKey(),
    job: text().notNull(),
    /** @deprecated Use projectId. */ project: text(),
    projectId: integer('project_id').references(() => project.id, { onDelete: 'restrict' }),
    sha256: text().notNull(),
    bytes: integer().notNull(),
    docCount: integer('doc_count').notNull(),
    docRevisions: text('doc_revisions').notNull(),
    compiledAt: text('compiled_at').notNull(),
    findings: integer().notNull(),
  },
  (t) => [unique('canon_pack_job_project_unique').on(t.job, t.project)],
)

export const canonEval = sqliteTable('canon_eval', {
  id: id(),
  slug: text().notNull(),
  runId: integer('run_id')
    .notNull()
    .references(() => run.id),
  canonSha: text('canon_sha').notNull(),
  agent: text().notNull(),
  model: text(),
  pass: integer().notNull(),
  why: text().notNull(),
  at: text().notNull(),
})
