// concern: postgres-schema-context-items
/** Hosted context items, tenant-bound independently from operator documents. */
import { sql } from 'drizzle-orm'
import { check, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { CONTEXT_HOLDER_KINDS, CONTEXT_ITEM_KINDS } from '../context-item-vocabulary.ts'
import { spaceIdentity, tenantPolicies } from './schema.ts'

export const contextItem = pgTable.withRLS(
  'context_item',
  {
    id: uuid('id').primaryKey(),
    spaceId: spaceIdentity(),
    holderKind: text('holder_kind').notNull(),
    holderId: text('holder_id').notNull(),
    slug: text().notNull(),
    kind: text().notNull(),
    body: text().notNull(),
    source: text().notNull(),
    questionNumber: integer('question_number'),
    target: text(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      'context_item_holder_kind_check',
      sql`${table.holderKind} IN (${sql.raw(CONTEXT_HOLDER_KINDS.map((value) => `'${value}'`).join(','))})`,
    ),
    check(
      'context_item_kind_check',
      sql`${table.kind} IN (${sql.raw(CONTEXT_ITEM_KINDS.map((value) => `'${value}'`).join(','))})`,
    ),
    unique('context_item_holder_slug_unique').on(
      table.spaceId,
      table.holderKind,
      table.holderId,
      table.slug,
    ),
    ...tenantPolicies('context_item', table.spaceId),
  ],
)
