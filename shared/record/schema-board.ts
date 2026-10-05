// concern: postgres-schema-board
/** Hosted board storage and its user- and project-scoped access boundary. */

import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  pgPolicy,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { machine, membership, project, RECORD_ACTOR_ROLE, user } from './schema.ts'
import { run } from './schema-run.ts'

const currentUser = sql`nullif(current_setting('app.user_id', true), '')::uuid`

function readsEveryScopedProject(scopeProjectIds: AnyPgColumn) {
  return sql`NOT EXISTS (
    SELECT 1 FROM unnest(${scopeProjectIds}) AS scoped(project_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM ${project} p
      JOIN ${membership} m ON m.space_id = p.space_id
      WHERE p.id = scoped.project_id AND m.user_id = ${currentUser}
    )
  )`
}

function writesEveryScopedProject(scopeProjectIds: AnyPgColumn) {
  return sql`NOT EXISTS (
    SELECT 1 FROM unnest(${scopeProjectIds}) AS scoped(project_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM ${project} p
      JOIN ${membership} m ON m.space_id = p.space_id
      WHERE p.id = scoped.project_id AND m.user_id = ${currentUser}
        AND m.permission = 'write'
    )
  )`
}

export const boardMessageRevision = pgSequence('board_message_revision')

export const boardClaim = pgTable.withRLS(
  'board_claim',
  {
    id: uuid().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => project.id),
    subjectKind: text('subject_kind').notNull(),
    subjectValue: text('subject_value').notNull(),
    holderUserId: uuid('holder_user_id')
      .notNull()
      .references(() => user.id),
    holderSession: text('holder_session'),
    note: text(),
    runId: uuid('run_id').references(() => run.id),
    durationMs: bigint('duration_ms', { mode: 'bigint' }).notNull(),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull(),
    renewedAt: timestamp('renewed_at', { withTimezone: true }).notNull(),
    lapsesAt: timestamp('lapses_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closeReason: text('close_reason'),
    supersededByClaimId: uuid('superseded_by_claim_id').references(
      (): AnyPgColumn => boardClaim.id,
    ),
  },
  (table) => {
    const projectMembership = sql`EXISTS (
      SELECT 1 FROM ${project} p
      JOIN ${membership} m ON m.space_id = p.space_id
      WHERE p.id = ${table.projectId} AND m.user_id = ${currentUser}
    )`
    const projectWriteMembership = sql`EXISTS (
      SELECT 1 FROM ${project} p
      JOIN ${membership} m ON m.space_id = p.space_id
      WHERE p.id = ${table.projectId} AND m.user_id = ${currentUser}
        AND m.permission = 'write'
    )`
    return [
      index('board_claim_project_subject_idx').on(
        table.projectId,
        table.subjectKind,
        table.subjectValue,
        table.closedAt,
      ),
      index('board_claim_run_idx').on(table.runId, table.closedAt),
      index('board_claim_superseded_idx').on(table.supersededByClaimId),
      check(
        'board_claim_subject_kind_check',
        sql`${table.subjectKind} IN ('task','path','resource')`,
      ),
      check(
        'board_claim_close_check',
        sql`(${table.closedAt} IS NULL AND ${table.closeReason} IS NULL) OR
          (${table.closedAt} IS NOT NULL AND ${table.closeReason} IS NOT NULL)`,
      ),
      check(
        'board_claim_close_reason_check',
        sql`${table.closeReason} IS NULL OR ${table.closeReason} IN
          ('released','lapsed','run-ended','task-closed','taken-over')`,
      ),
      pgPolicy('board_claim_actor_select', {
        for: 'select',
        to: RECORD_ACTOR_ROLE,
        using: projectMembership,
      }),
      pgPolicy('board_claim_actor_insert', {
        for: 'insert',
        to: RECORD_ACTOR_ROLE,
        withCheck: sql`${table.holderUserId} = ${currentUser} AND ${projectWriteMembership}`,
      }),
      pgPolicy('board_claim_actor_update', {
        for: 'update',
        to: RECORD_ACTOR_ROLE,
        using: projectWriteMembership,
        withCheck: projectWriteMembership,
      }),
    ]
  },
)

export const boardMessage = pgTable.withRLS(
  'board_message',
  {
    id: uuid().primaryKey(),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => user.id),
    authorSession: text('author_session'),
    authorHarness: text('author_harness'),
    authorMachineId: uuid('author_machine_id').references(() => machine.id),
    authorRunId: uuid('author_run_id').references(() => run.id),
    kind: text().notNull(),
    threadRootId: uuid('thread_root_id').references((): AnyPgColumn => boardMessage.id, {
      onDelete: 'cascade',
    }),
    audience: text(),
    title: text(),
    body: text().notNull(),
    ackRequired: boolean('ack_required').notNull(),
    ackDeadline: timestamp('ack_deadline', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    acceptedReplyId: uuid('accepted_reply_id').references((): AnyPgColumn => boardMessage.id),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => user.id),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    noteId: uuid('note_id'),
    notePendingError: text('note_pending_error'),
    noteFilingStartedAt: timestamp('note_filing_started_at', { withTimezone: true }),
    claimId: uuid('claim_id').references(() => boardClaim.id),
    scopeProjectIds: uuid('scope_project_ids').array().notNull().default(sql`ARRAY[]::uuid[]`),
    recipientUserIds: uuid('recipient_user_ids').array().notNull().default(sql`ARRAY[]::uuid[]`),
    revision: bigint({ mode: 'bigint' }).notNull().default(sql`nextval('board_message_revision')`),
  },
  (table) => {
    const readsScope = readsEveryScopedProject(table.scopeProjectIds)
    const writesScope = writesEveryScopedProject(table.scopeProjectIds)
    const visible = sql`${table.authorUserId} = ${currentUser} OR
      (cardinality(${table.scopeProjectIds}) > 0 AND ${readsScope}) OR
      (${currentUser} = ANY(${table.recipientUserIds}) AND ${readsScope})`
    const replyRootVisibleAndMatching = sql`(${table.kind} <> 'reply' OR EXISTS (
      SELECT 1 FROM board_message root
      WHERE root.id = ${table.threadRootId}
        AND root.scope_project_ids = ${table.scopeProjectIds}
        AND root.recipient_user_ids = ${table.recipientUserIds}
    ))`
    const writesRow = sql`${table.authorUserId} = ${currentUser} AND ${writesScope}
      AND ${replyRootVisibleAndMatching}`
    return [
      index('board_message_revision_idx').on(table.revision),
      index('board_message_delivery_idx').on(table.expiresAt, table.withdrawnAt, table.createdAt),
      index('board_message_author_rate_idx').on(
        table.authorUserId,
        table.authorSession,
        table.authorRunId,
        table.createdAt,
      ),
      index('board_message_thread_idx').on(table.threadRootId, table.createdAt, table.id),
      check(
        'board_message_kind_check',
        sql`${table.kind} IN ('notice','suggestion','question','reply')`,
      ),
      check(
        'board_message_reply_shape_check',
        sql`(${table.kind} = 'reply' AND ${table.threadRootId} IS NOT NULL
          AND ${table.audience} IS NULL AND ${table.title} IS NULL
          AND ${table.ackRequired} = false AND ${table.ackDeadline} IS NULL
          AND ${table.expiresAt} IS NULL) OR
          (${table.kind} <> 'reply' AND ${table.threadRootId} IS NULL
          AND ${table.audience} IS NOT NULL AND ${table.title} IS NOT NULL
          AND ${table.expiresAt} IS NOT NULL)`,
      ),
      check(
        'board_message_acceptance_check',
        sql`(${table.acceptedReplyId} IS NULL AND ${table.acceptedByUserId} IS NULL
          AND ${table.acceptedAt} IS NULL) OR
          (${table.kind} = 'question' AND ${table.acceptedReplyId} IS NOT NULL
          AND ${table.acceptedByUserId} IS NOT NULL AND ${table.acceptedAt} IS NOT NULL)`,
      ),
      check(
        'board_message_note_check',
        sql`${table.kind} = 'question' OR (${table.noteId} IS NULL
          AND ${table.notePendingError} IS NULL AND ${table.noteFilingStartedAt} IS NULL)`,
      ),
      pgPolicy('board_message_actor_select', {
        for: 'select',
        to: RECORD_ACTOR_ROLE,
        using: visible,
      }),
      pgPolicy('board_message_actor_insert', {
        for: 'insert',
        to: RECORD_ACTOR_ROLE,
        withCheck: writesRow,
      }),
      pgPolicy('board_message_actor_update', {
        for: 'update',
        to: RECORD_ACTOR_ROLE,
        using: sql`${table.authorUserId} = ${currentUser}`,
        withCheck: writesRow,
      }),
      pgPolicy('board_message_actor_delete', {
        for: 'delete',
        to: RECORD_ACTOR_ROLE,
        using: sql`${table.authorUserId} = ${currentUser}`,
      }),
    ]
  },
)

export const boardMessageTag = pgTable.withRLS(
  'board_message_tag',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => boardMessage.id, { onDelete: 'cascade' }),
    kind: text().notNull(),
    value: text().notNull(),
    origin: text().notNull(),
  },
  (table) => {
    const messageVisible = sql`EXISTS (
      SELECT 1 FROM ${boardMessage} message WHERE message.id = ${table.messageId}
    )`
    const messageAuthored = sql`EXISTS (
      SELECT 1 FROM ${boardMessage} message
      WHERE message.id = ${table.messageId} AND message.author_user_id = ${currentUser}
    )`
    return [
      primaryKey({ columns: [table.messageId, table.kind, table.value, table.origin] }),
      index('board_message_tag_message_idx').on(table.messageId),
      check('board_message_tag_kind_check', sql`${table.kind} IN ('task','path','topic')`),
      check('board_message_tag_origin_check', sql`${table.origin} IN ('sender','inferred')`),
      pgPolicy('board_message_tag_actor_select', {
        for: 'select',
        to: RECORD_ACTOR_ROLE,
        using: messageVisible,
      }),
      pgPolicy('board_message_tag_actor_insert', {
        for: 'insert',
        to: RECORD_ACTOR_ROLE,
        withCheck: messageAuthored,
      }),
      pgPolicy('board_message_tag_actor_update', {
        for: 'update',
        to: RECORD_ACTOR_ROLE,
        using: messageAuthored,
        withCheck: messageAuthored,
      }),
      pgPolicy('board_message_tag_actor_delete', {
        for: 'delete',
        to: RECORD_ACTOR_ROLE,
        using: messageAuthored,
      }),
    ]
  },
)

export const boardReceipt = pgTable.withRLS(
  'board_receipt',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => boardMessage.id, { onDelete: 'cascade' }),
    readerUserId: uuid('reader_user_id')
      .notNull()
      .references(() => user.id),
    readerSession: text('reader_session').notNull(),
    audienceAtPosting: boolean('audience_at_posting').notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  },
  (table) => {
    const ownReceipt = sql`${table.readerUserId} = ${currentUser}`
    const visibleMessage = sql`EXISTS (
      SELECT 1 FROM ${boardMessage} message WHERE message.id = ${table.messageId}
    )`
    const messageAuthored = sql`EXISTS (
      SELECT 1 FROM ${boardMessage} message
      WHERE message.id = ${table.messageId} AND message.author_user_id = ${currentUser}
    )`
    const writesReceipt = sql`${ownReceipt} AND ${visibleMessage}`
    return [
      primaryKey({ columns: [table.messageId, table.readerUserId, table.readerSession] }),
      pgPolicy('board_receipt_actor_select', {
        for: 'select',
        to: RECORD_ACTOR_ROLE,
        using: sql`${ownReceipt} OR ${messageAuthored}`,
      }),
      pgPolicy('board_receipt_actor_insert', {
        for: 'insert',
        to: RECORD_ACTOR_ROLE,
        withCheck: writesReceipt,
      }),
      pgPolicy('board_receipt_actor_update', {
        for: 'update',
        to: RECORD_ACTOR_ROLE,
        using: writesReceipt,
        withCheck: writesReceipt,
      }),
    ]
  },
)
