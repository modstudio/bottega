// concern: postgres-schema-question
/** Knows the hosted question evidence shape. Must not know local execution or synchronization. */
import { type SQLWrapper, sql } from 'drizzle-orm'
import { integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { machine, project, spaceIdentity, tenantPolicies } from './schema.ts'
import { run } from './schema-run.ts'

export function hostedQuestionWins(incoming: SQLWrapper, hosted: SQLWrapper) {
  return sql`${incoming} > ${hosted}`
}

export const question = pgTable.withRLS(
  'question',
  {
    id: uuid().primaryKey(),
    spaceId: spaceIdentity(),
    runId: uuid('run_id').references(() => run.id),
    workflowKey: text('workflow_key'),
    workflowCursorRecordId: uuid('workflow_cursor_record_id'),
    projectId: uuid('project_id').references(() => project.id),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machine.id),
    revision: integer().notNull(),
    askedAt: timestamp('asked_at', { withTimezone: true }).notNull(),
    question: text().notNull(),
    options: jsonb(),
    recommendation: text(),
    why: text(),
    askedVia: text('asked_via'),
    answer: text(),
    answerBasis: text('answer_basis'),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    answeredBy: text('answered_by'),
    answererKind: text('answerer_kind'),
    answerChannel: text('answer_channel'),
    awaitingOperatorAt: timestamp('awaiting_operator_at', { withTimezone: true }),
    relayedBy: text('relayed_by'),
    overturnedAt: timestamp('overturned_at', { withTimezone: true }),
    overturnedBy: text('overturned_by'),
    overturnReason: text('overturn_reason'),
    replacement: text(),
    filedAs: text('filed_as'),
    filedRef: text('filed_ref'),
    filedRecordId: uuid('filed_record_id'),
    filedLabel: text('filed_label'),
    filedAt: timestamp('filed_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closeReason: text('close_reason'),
    withheldFields: jsonb('withheld_fields').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [...tenantPolicies('question', table.spaceId)],
)

export const questionMutationAudit = pgTable.withRLS(
  'question_mutation_audit',
  {
    id: uuid('id').primaryKey(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => question.id),
    spaceId: spaceIdentity(),
    action: text().notNull(),
    actorSession: text('actor_session'),
    at: timestamp({ withTimezone: true }).notNull(),
    reason: text(),
  },
  (table) => [
    unique('question_mutation_audit_identity').on(table.questionId, table.action, table.at),
    ...tenantPolicies('question_mutation_audit', table.spaceId),
  ],
)
