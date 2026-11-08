// concern: postgres-schema-board
/** Hosted board storage and its user- and project-scoped access boundary. */

import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  pgPolicy,
  pgSequence,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { REPLY_AUDIENCE_OPTIONS } from '../board-reply-audience-options.ts'
import { MODERATION_HIDE_REASONS } from '../moderation-hide-reason.ts'
import {
  machine,
  membership,
  project,
  RECORD_ACTOR_ROLE,
  RECORD_OWNER_ROLE,
  space,
  user,
} from './schema.ts'
import { run } from './schema-run.ts'

const currentUser = sql`nullif(current_setting('app.user_id', true), '')::uuid`

/** Board visibility is membership within bound spaces; the service binds every user space. */
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

function sharesAnyAuthorSpace(authorUserId: AnyPgColumn) {
  return sql`record_board_author_shares_space(${authorUserId})`
}

function ownsAnyScopedProject(scopeProjectIds: AnyPgColumn) {
  return sql`EXISTS (
      SELECT 1 FROM unnest(${scopeProjectIds}) scoped(project_id)
      JOIN ${project} p ON p.id = scoped.project_id
      JOIN ${membership} m ON m.space_id = p.space_id
      WHERE m.user_id = ${currentUser} AND m.role = 'owner'
    )`
}

function ownsAuthorRun(authorRunId: AnyPgColumn) {
  return sql`${authorRunId} IS NOT NULL AND EXISTS (
    SELECT 1 FROM ${run} r
    JOIN ${membership} m ON m.space_id = r.space_id
    WHERE r.id = ${authorRunId} AND m.user_id = ${currentUser} AND m.role = 'owner'
  )`
}

function hiddenBoardRowRules(table: {
  hiddenAt: AnyPgColumn
  hiddenByUserId: AnyPgColumn
  hiddenReason: AnyPgColumn
  authorUserId: AnyPgColumn
  authorRunId: AnyPgColumn
  scopeProjectIds: AnyPgColumn
}) {
  return [
    check(
      'board_message_hidden_shape_check',
      sql`(${table.hiddenAt} IS NULL AND ${table.hiddenByUserId} IS NULL AND ${table.hiddenReason} IS NULL) OR
          (${table.hiddenAt} IS NOT NULL AND ${table.hiddenByUserId} IS NOT NULL AND ${table.hiddenReason} IS NOT NULL)`,
    ),
    check(
      'board_message_hidden_reason_check',
      sql`${table.hiddenReason} IS NULL OR ${table.hiddenReason} IN ${MODERATION_HIDE_REASONS}`,
    ),
    pgPolicy('board_message_hidden_select', {
      as: 'restrictive',
      for: 'select',
      to: RECORD_ACTOR_ROLE,
      using: sql`${table.hiddenAt} IS NULL OR ${table.authorUserId} = ${currentUser} OR ${ownsAnyScopedProject(table.scopeProjectIds)} OR ${ownsAuthorRun(table.authorRunId)}`,
    }),
  ]
}

export const boardMessageRevision = pgSequence('board_message_revision')

export const boardPresence = pgTable.withRLS(
  'board_presence',
  {
    id: uuid().primaryKey(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => space.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    session: text().notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => project.id),
    role: text().notNull(),
    machineId: uuid('machine_id').references(() => machine.id),
    firstSeen: timestamp('first_seen', { withTimezone: true }).notNull(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).notNull(),
  },
  (table) => {
    const currentSpace = sql`nullif(current_setting('app.space_id', true), '')::uuid`
    const ownsPresence = sql`${table.spaceId} = ${currentSpace} AND ${table.userId} = ${currentUser}`
    const hasMembership = sql`EXISTS (
      SELECT 1 FROM ${membership} m
      WHERE m.space_id = ${table.spaceId} AND m.user_id = ${currentUser}
    )`
    const writesPresence = sql`(${ownsPresence}) AND (${hasMembership})`
    return [
      unique('board_presence_space_session_unique').on(table.spaceId, table.session),
      index('board_presence_last_seen_idx').on(table.lastSeen),
      check('board_presence_role_check', sql`${table.role} = 'architect'`),
      pgPolicy('board_presence_space_select', {
        for: 'select',
        using: sql`${table.spaceId} = ${currentSpace} OR ${table.spaceId} = ANY(
          string_to_array(nullif(current_setting('app.space_ids', true), ''), ',')::uuid[]
        )`,
      }),
      pgPolicy('board_presence_space_insert', { for: 'insert', withCheck: writesPresence }),
      pgPolicy('board_presence_space_update', {
        for: 'update',
        using: writesPresence,
        withCheck: writesPresence,
      }),
      pgPolicy('board_presence_owner_all', {
        for: 'all',
        to: RECORD_OWNER_ROLE,
        using: sql`true`,
        withCheck: sql`true`,
      }),
    ]
  },
)

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
    // Board policies already distinguish write membership from read membership.
    return [
      index('board_claim_project_subject_idx').on(
        table.projectId,
        table.subjectKind,
        table.subjectValue,
        table.closedAt,
      ),
      uniqueIndex('board_claim_live_subject_unique')
        .on(table.projectId, table.subjectKind, table.subjectValue)
        .where(sql`${table.closedAt} IS NULL`),
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
      pgPolicy('board_claim_owner_delete', {
        for: 'delete',
        to: RECORD_ACTOR_ROLE,
        using: sql`EXISTS (
          SELECT 1 FROM ${project} p
          JOIN ${membership} m ON m.space_id = p.space_id
          WHERE p.id = ${table.projectId} AND m.user_id = ${currentUser} AND m.role = 'owner'
        )`,
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
    authorProjectId: uuid('author_project_id').references(() => project.id, {
      onDelete: 'set null',
    }),
    kind: text().notNull(),
    purpose: text(),
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
    sharedSpaceReach: boolean('shared_space_reach').notNull().default(false),
    threadRootAuthorUserId: uuid('thread_root_author_user_id')
      .notNull()
      .references(() => user.id),
    revision: bigint({ mode: 'bigint' })
      .notNull()
      .default(sql`nextval('public.board_message_revision'::regclass)`),
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    hiddenByUserId: uuid('hidden_by_user_id').references(() => user.id),
    hiddenReason: text('hidden_reason'),
  },
  (table) => {
    const readsScope = readsEveryScopedProject(table.scopeProjectIds)
    const writesScope = writesEveryScopedProject(table.scopeProjectIds)
    const visible = sql`${table.authorUserId} = ${currentUser} OR
      ${table.threadRootAuthorUserId} = ${currentUser} OR
      (${table.sharedSpaceReach} AND ${sharesAnyAuthorSpace(table.threadRootAuthorUserId)}) OR
      (cardinality(${table.scopeProjectIds}) > 0 AND ${readsScope}) OR
      (${currentUser} = ANY(${table.recipientUserIds}) AND ${readsScope})`
    const writesRow = sql`${table.authorUserId} = ${currentUser} AND ${writesScope}`
    // Board policies already distinguish write membership from read membership.
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
        'board_message_purpose_check',
        sql`(${table.kind} = 'reply' AND ${table.purpose} IS NULL) OR
          (${table.kind} <> 'reply' AND
            (${table.purpose} IS NULL OR ${table.purpose} IN ('information','request','standing')))`,
      ),
      check(
        'board_message_reply_shape_check',
        sql`(${table.kind} = 'reply' AND ${table.threadRootId} IS NOT NULL
          AND (${table.audience} IS NULL OR ${table.audience} IN ${REPLY_AUDIENCE_OPTIONS}
            OR (${table.audience} LIKE 'session:%' AND ${table.audience} <> 'session:'))
          AND ${table.title} IS NULL
          AND ${table.ackRequired} = false AND ${table.ackDeadline} IS NULL
          AND ${table.expiresAt} IS NULL) OR
          (${table.kind} <> 'reply' AND ${table.threadRootId} IS NULL
          AND ${table.audience} IS NOT NULL AND ${table.title} IS NOT NULL
          AND ${table.expiresAt} IS NOT NULL)`,
      ),
      check(
        'board_message_shared_space_reach_check',
        sql`(${table.kind} = 'reply' OR ${table.sharedSpaceReach} = (${table.audience} = 'spaces'))
          AND (NOT ${table.sharedSpaceReach} OR
            (cardinality(${table.scopeProjectIds}) = 0
              AND cardinality(${table.recipientUserIds}) = 0))`,
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
      ...hiddenBoardRowRules(table),
      pgPolicy('board_message_actor_select', {
        for: 'select',
        to: RECORD_ACTOR_ROLE,
        using: visible,
      }),
      pgPolicy('board_message_run_owner_select', {
        for: 'select',
        to: RECORD_ACTOR_ROLE,
        using: ownsAuthorRun(table.authorRunId),
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
      pgPolicy('board_message_run_owner_delete', {
        for: 'delete',
        to: RECORD_ACTOR_ROLE,
        using: ownsAuthorRun(table.authorRunId),
      }),
      // A first acknowledgement advances this message's revision for the change feed. No actor
      // policy can allow it: a reader may only write their own receipt, and the message belongs
      // to its author. The definer function performs that one write as the table owner, which
      // FORCE ROW LEVEL SECURITY applies to as well, so the owner needs exactly these two grants:
      // the row must be visible to it before the update can reach it.
      pgPolicy('board_message_owner_select', {
        for: 'select',
        to: RECORD_OWNER_ROLE,
        using: sql`true`,
      }),
      pgPolicy('board_message_owner_insert', {
        for: 'insert',
        to: RECORD_OWNER_ROLE,
        withCheck: sql`true`,
      }),
      pgPolicy('board_message_owner_update', {
        for: 'update',
        to: RECORD_OWNER_ROLE,
        using: sql`true`,
        withCheck: sql`true`,
      }),
    ]
  },
)

const spaceOwner = (spaceId: AnyPgColumn) => sql`EXISTS (
  SELECT 1 FROM ${membership} m
  WHERE m.space_id = ${spaceId} AND m.user_id = ${currentUser} AND m.role = 'owner'
)`
const spaceMember = (spaceId: AnyPgColumn) => sql`EXISTS (
  SELECT 1 FROM ${membership} m
  WHERE m.space_id = ${spaceId} AND m.user_id = ${currentUser}
)`

export const spaceOutsideIntake = pgTable.withRLS(
  'space_outside_intake',
  {
    id: uuid().primaryKey(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => space.id),
    projectId: uuid('project_id')
      .notNull()
      .references(() => project.id),
    pausedUntil: timestamp('paused_until', { withTimezone: true }),
    pausedByUserId: uuid('paused_by_user_id').references(() => user.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => {
    const owner = spaceOwner(table.spaceId)
    return [
      unique('space_outside_intake_space_unique').on(table.spaceId),
      foreignKey({
        columns: [table.spaceId, table.projectId],
        foreignColumns: [project.spaceId, project.id],
        name: 'space_outside_intake_space_project_fk',
      }).onUpdate('cascade'),
      pgPolicy('space_outside_intake_actor_select', {
        for: 'select',
        to: RECORD_ACTOR_ROLE,
        using: spaceMember(table.spaceId),
      }),
      pgPolicy('space_outside_intake_actor_insert', {
        for: 'insert',
        to: RECORD_ACTOR_ROLE,
        withCheck: owner,
      }),
      pgPolicy('space_outside_intake_actor_update', {
        for: 'update',
        to: RECORD_ACTOR_ROLE,
        using: owner,
        withCheck: owner,
      }),
      pgPolicy('space_outside_intake_actor_delete', {
        for: 'delete',
        to: RECORD_ACTOR_ROLE,
        using: owner,
      }),
      pgPolicy('space_outside_intake_owner_select', {
        for: 'select',
        to: RECORD_OWNER_ROLE,
        using: sql`true`,
      }),
    ]
  },
)

export const spacePostingBlock = pgTable.withRLS(
  'space_posting_block',
  {
    id: uuid().primaryKey(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => space.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    blockedUntil: timestamp('blocked_until', { withTimezone: true }),
    blockedByUserId: uuid('blocked_by_user_id')
      .notNull()
      .references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => {
    const owner = spaceOwner(table.spaceId)
    return [
      unique('space_posting_block_space_user_unique').on(table.spaceId, table.userId),
      pgPolicy('space_posting_block_actor_select', {
        for: 'select',
        to: RECORD_ACTOR_ROLE,
        using: owner,
      }),
      pgPolicy('space_posting_block_actor_insert', {
        for: 'insert',
        to: RECORD_ACTOR_ROLE,
        withCheck: owner,
      }),
      pgPolicy('space_posting_block_actor_update', {
        for: 'update',
        to: RECORD_ACTOR_ROLE,
        using: owner,
        withCheck: owner,
      }),
      pgPolicy('space_posting_block_actor_delete', {
        for: 'delete',
        to: RECORD_ACTOR_ROLE,
        using: owner,
      }),
      pgPolicy('space_posting_block_owner_select', {
        for: 'select',
        to: RECORD_OWNER_ROLE,
        using: sql`true`,
      }),
    ]
  },
)

export const spaceOutsideWrite = pgTable.withRLS(
  'space_outside_write',
  {
    id: uuid().primaryKey(),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => space.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    kind: text().notNull(),
    subjectId: uuid('subject_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('space_outside_write_user_created_idx').on(table.userId, table.createdAt),
    check('space_outside_write_kind_check', sql`${table.kind} IN ('post','reply','note')`),
    pgPolicy('space_outside_write_actor_select', {
      for: 'select',
      to: RECORD_ACTOR_ROLE,
      using: sql`${table.userId} = ${currentUser}`,
    }),
    pgPolicy('space_outside_write_owner_insert', {
      for: 'insert',
      to: RECORD_OWNER_ROLE,
      withCheck: sql`true`,
    }),
  ],
)

export const boardMessageTag = pgTable.withRLS(
  'board_message_tag',
  {
    id: uuid('id').primaryKey(),
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
    // Board policies already distinguish write membership from read membership.
    return [
      unique('board_message_tag_message_kind_value_origin_unique').on(
        table.messageId,
        table.kind,
        table.value,
        table.origin,
      ),
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
    id: uuid('id').primaryKey(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => boardMessage.id, { onDelete: 'cascade' }),
    readerUserId: uuid('reader_user_id')
      .notNull()
      .references(() => user.id),
    readerSession: text('reader_session').notNull(),
    // Hosted receipts can arrive while their live run still has no terminal outbox row.
    readerRunRecordId: uuid('reader_run_record_id'),
    audienceAtPosting: boolean('audience_at_posting').notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    successor: boolean().notNull().default(false),
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
    // Board policies already distinguish write membership from read membership.
    return [
      unique('board_receipt_message_reader_session_unique').on(
        table.messageId,
        table.readerUserId,
        table.readerSession,
      ),
      uniqueIndex('board_receipt_message_successor_unique')
        .on(table.messageId)
        .where(sql`${table.successor}`),
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
      // Definer functions publish receipt revisions and elect successors across all users.
      pgPolicy('board_receipt_owner_select', {
        for: 'select',
        to: RECORD_OWNER_ROLE,
        using: sql`true`,
      }),
      pgPolicy('board_receipt_owner_insert', {
        for: 'insert',
        to: RECORD_OWNER_ROLE,
        withCheck: sql`true`,
      }),
      pgPolicy('board_receipt_owner_update', {
        for: 'update',
        to: RECORD_OWNER_ROLE,
        using: sql`true`,
        withCheck: sql`true`,
      }),
    ]
  },
)
