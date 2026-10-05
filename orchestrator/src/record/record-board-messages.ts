// concern: record-board-messages
/** Owns hosted board message writes and thread reads. Must not know HTTP or local stores. */

import type { SQL } from 'bun'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import {
  type Audience,
  BOARD_BODY_MAX_CHARS,
  BOARD_DUPLICATE_WINDOW_MS,
  BOARD_POST_RATE_WINDOW_MS,
  messageIsLive,
  postDecision,
  requireRealSession,
  validatePostNoticeInput,
} from '../board/board-policy.ts'
import {
  type BoardTag,
  inferredBoardTags,
  senderBoardTags,
  senderTagKey,
} from '../board/board-tags.ts'
import {
  acceptRefusal,
  BOARD_NOTE_FILING_LEASE_MS,
  noteFilingLeaseDecision,
  replyRefusal,
} from '../board/board-thread-policy.ts'
import {
  asBoardError,
  type HostedBoardCreateContent,
  type HostedBoardMessage,
  type HostedBoardPostInput,
  type HostedBoardReply,
  type HostedBoardReplyInput,
  type HostedBoardSessionInput,
  type HostedBoardThread,
  RecordBoardError,
} from './record-board-contract.ts'
import {
  hostedBoardActor,
  hostedBoardPostRefusal,
  hostedBoardScope,
  hostedProjectNameForAudience,
  hostedUuidList,
  parseHostedAudience,
  sameHostedBoardCreateContent,
} from './record-board-scope.ts'
import { type BoardTenant, boardUuidArray, withBoardTenant } from './record-board-tx.ts'

type HostedBoardForcedScope = {
  scopeProjectIds: string[]
  recipientUserIds: string[]
  claimId?: string | null
}

const RATE_LIMITED = 'board post rate limit reached; retry after the ten-minute author window'

const iso = (value: unknown) => {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  return new Date(String(value)).toISOString()
}

function asTags(rows: Record<string, unknown>[]): BoardTag[] {
  return rows.map((row) => ({
    kind: String(row.kind) as BoardTag['kind'],
    value: String(row.value),
    origin: String(row.origin) as BoardTag['origin'],
  }))
}

function hostedBoardOrigin(row: Record<string, unknown>): HostedBoardMessage['origin'] {
  return {
    kind: row.author_session ? 'architect' : 'operator',
    session: row.author_session == null ? null : String(row.author_session),
    harness: row.author_harness == null ? null : String(row.author_harness),
    project: null,
    runId: row.author_run_id == null ? null : String(row.author_run_id),
  }
}

function rootState(row: Record<string, unknown>, clock: number): string | null {
  if (String(row.kind) === 'reply') return null
  if (row.accepted_reply_id != null) return 'accepted'
  if (row.withdrawn_at != null) return 'withdrawn'
  const expiresAt = iso(row.expires_at)
  if (expiresAt && Date.parse(expiresAt) <= clock) return 'expired'
  return 'open'
}

export function hostedBoardMessageView(
  row: Record<string, unknown>,
  tags: BoardTag[],
  clock = Date.now(),
): HostedBoardMessage {
  return {
    id: String(row.id),
    kind: String(row.kind),
    title: row.title == null ? null : String(row.title),
    body: String(row.body),
    audience: row.audience == null ? null : String(row.audience),
    origin: hostedBoardOrigin(row),
    senderTags: tags
      .filter((tag) => tag.origin === 'sender')
      .map(({ kind, value }) => ({ kind, value })),
    createdAt: iso(row.created_at)!,
    expiresAt: iso(row.expires_at),
    withdrawnAt: iso(row.withdrawn_at),
    state: rootState(row, clock),
    acceptedReplyId: row.accepted_reply_id == null ? null : String(row.accepted_reply_id),
    acceptedBy: row.accepted_by_user_id == null ? null : String(row.accepted_by_user_id),
    acceptedAt: iso(row.accepted_at),
    noteId: row.note_id == null ? null : String(row.note_id),
    notePendingError: row.note_pending_error == null ? null : String(row.note_pending_error),
    revision: String(row.revision),
    scopeProjectIds: hostedUuidList(row.scope_project_ids),
    recipientUserIds: hostedUuidList(row.recipient_user_ids),
    claimId: row.claim_id == null ? null : String(row.claim_id),
    authorUserId: String(row.author_user_id),
    authorSession: row.author_session == null ? null : String(row.author_session),
    ackRequired: Boolean(row.ack_required),
    ackDeadline: iso(row.ack_deadline),
  }
}

function hostedBoardReplyView(row: Record<string, unknown>): HostedBoardReply {
  return {
    id: String(row.id),
    body: String(row.body),
    origin: hostedBoardOrigin(row),
    createdAt: iso(row.created_at)!,
  }
}

function createContent(row: Record<string, unknown>, tags: BoardTag[]): HostedBoardCreateContent {
  return {
    kind: String(row.kind),
    audience: row.audience == null ? null : String(row.audience),
    title: row.title == null ? null : String(row.title),
    body: String(row.body),
    ackRequired: Boolean(row.ack_required),
    ackDeadline: iso(row.ack_deadline),
    expiresAt: iso(row.expires_at),
    threadRootId: row.thread_root_id == null ? null : String(row.thread_root_id),
    scopeProjectIds: hostedUuidList(row.scope_project_ids),
    recipientUserIds: hostedUuidList(row.recipient_user_ids),
    claimId: row.claim_id == null ? null : String(row.claim_id),
    senderTags: tags
      .filter((tag) => tag.origin === 'sender')
      .map(({ kind, value }) => ({ kind, value })),
  }
}

async function messageTags(tx: SQL, id: string): Promise<BoardTag[]> {
  const rows = await tx`
    SELECT kind, value, origin FROM board_message_tag
    WHERE message_id=${id}::uuid ORDER BY kind, value, origin
  `
  return asTags(rows as Record<string, unknown>[])
}

export async function loadHostedBoardMessage(
  tx: SQL,
  id: string,
): Promise<{ row: Record<string, unknown>; tags: BoardTag[] } | null> {
  const rows = await tx`SELECT * FROM board_message WHERE id=${id}::uuid`
  if (!rows[0]) return null
  return { row: rows[0] as Record<string, unknown>, tags: await messageTags(tx, id) }
}

async function viewById(tx: SQL, id: string, clock: number): Promise<HostedBoardMessage> {
  const loaded = await loadHostedBoardMessage(tx, id)
  if (!loaded) throw new RecordBoardError(`board message ${id} not found`, 404)
  return hostedBoardMessageView(loaded.row, loaded.tags, clock)
}

export async function resolveVisibleProjectId(tx: SQL, name: string): Promise<string> {
  const rows = await tx`SELECT id FROM project WHERE name=${name} AND retired_at IS NULL`
  if (rows.length !== 1)
    throw new RecordBoardError(`unknown or invisible board project ${name}`, 400)
  return String(rows[0]!.id)
}

function sessionOrNull(value: string | null | undefined): string | null {
  const actor = hostedBoardActor(value)
  if (actor.kind === 'architect')
    asBoardError(() => requireRealSession(actor.session, 'hosted board'))
  return actor.session
}

async function authorWindow(
  tx: SQL,
  userId: string,
  session: string | null,
  clock: number,
  duplicate: boolean,
) {
  const since = new Date(clock - BOARD_POST_RATE_WINDOW_MS).toISOString()
  const rows = await tx`
    SELECT COUNT(*)::int AS n FROM board_message
    WHERE author_user_id=${userId}::uuid
      AND author_session IS NOT DISTINCT FROM ${session}
      AND created_at>=${since}::timestamptz
  `
  return postDecision({ recentPosts: Number(rows[0]?.n ?? 0), duplicate })
}

async function duplicateRootId(
  tx: SQL,
  input: {
    kind: string
    userId: string
    session: string | null
    audience: string
    title: string
    body: string
  },
  senderTags: BoardTag[],
  clock: number,
): Promise<string | null> {
  const duplicateSince = new Date(clock - BOARD_DUPLICATE_WINDOW_MS).toISOString()
  const candidates = (await tx`
    SELECT id FROM board_message
    WHERE kind=${input.kind} AND author_user_id=${input.userId}::uuid
      AND author_session IS NOT DISTINCT FROM ${input.session}
      AND audience IS NOT DISTINCT FROM ${input.audience}
      AND title IS NOT DISTINCT FROM ${input.title}
      AND body=${input.body}
      AND created_at>=${duplicateSince}::timestamptz
    ORDER BY created_at DESC
  `) as { id: string }[]
  for (const candidate of candidates) {
    const loaded = await loadHostedBoardMessage(tx, String(candidate.id))
    if (!loaded) continue
    if (
      senderTagKey(loaded.tags.filter((tag) => tag.origin === 'sender')) ===
      senderTagKey(senderTags)
    ) {
      return String(candidate.id)
    }
  }
  return null
}

async function insertTags(tx: SQL, messageId: string, tags: BoardTag[]): Promise<void> {
  for (const tag of tags) {
    await tx`
      INSERT INTO board_message_tag (message_id, kind, value, origin)
      VALUES (${messageId}::uuid, ${tag.kind}, ${tag.value}, ${tag.origin})
      ON CONFLICT DO NOTHING
    `
  }
}

async function insertRoot(
  tx: SQL,
  input: HostedBoardPostInput,
  userId: string,
  session: string | null,
  audience: Audience,
  tags: BoardTag[],
  clock: number,
  forcedScope?: HostedBoardForcedScope,
): Promise<string> {
  const projectName = hostedProjectNameForAudience(audience, input.project)
  if (
    (audience.kind === 'project' || audience.kind === 'workers' || audience.kind === 'task') &&
    !projectName
  ) {
    throw new RecordBoardError(
      audience.kind === 'task'
        ? 'task audience requires the author project; send project'
        : 'board project audience needs a visible project name',
      400,
    )
  }
  if (
    projectName &&
    input.project &&
    (audience.kind === 'project' || audience.kind === 'workers') &&
    input.project !== projectName
  ) {
    throw new RecordBoardError(
      `board project ${input.project} does not match audience ${audience.kind}:${projectName}`,
      400,
    )
  }
  const projectId = projectName ? await resolveVisibleProjectId(tx, projectName) : null
  const derived = hostedBoardScope(audience, projectId)
  const scopeProjectIds = forcedScope?.scopeProjectIds ?? derived.scopeProjectIds
  const recipients = forcedScope?.recipientUserIds ?? derived.recipientUserIds
  const claimId = forcedScope?.claimId ?? null
  const createdAt = new Date(clock).toISOString()
  const ackRequired = input.ackRequired ?? false
  await tx`
    INSERT INTO board_message (
      id, author_user_id, author_session, author_harness, author_machine_id, author_run_id,
      kind, thread_root_id, audience, title, body, ack_required, ack_deadline, expires_at,
      created_at, claim_id, scope_project_ids, recipient_user_ids
    ) VALUES (
      ${input.id}::uuid, ${userId}::uuid, ${session}, ${input.authorHarness ?? null},
      ${input.authorMachineId ?? null}::uuid, ${input.authorRunId ?? null}::uuid,
      ${input.kind}, NULL, ${input.audience}, ${input.title}, ${input.body}, ${ackRequired},
      ${input.ackDeadline ?? null}::timestamptz, ${input.expiresAt}::timestamptz,
      ${createdAt}::timestamptz, ${claimId}::uuid,
      COALESCE(${boardUuidArray(tx, scopeProjectIds)}, ARRAY[]::uuid[]),
      COALESCE(${boardUuidArray(tx, recipients)}, ARRAY[]::uuid[])
    )
  `
  await insertTags(tx, input.id, tags)
  return input.id
}

async function storedArraysMatch(
  tx: SQL,
  id: string,
  scopeProjectIds: string[],
  recipientUserIds: string[],
): Promise<boolean> {
  const rows = (await tx`
    SELECT
      scope_project_ids IS NOT DISTINCT FROM COALESCE(${boardUuidArray(tx, scopeProjectIds)}, ARRAY[]::uuid[])
        AS same_scope,
      recipient_user_ids IS NOT DISTINCT FROM COALESCE(${boardUuidArray(tx, recipientUserIds)}, ARRAY[]::uuid[])
        AS same_recipients
    FROM board_message WHERE id=${id}::uuid
  `) as { same_scope: boolean; same_recipients: boolean }[]
  return Boolean(rows[0]?.same_scope && rows[0]?.same_recipients)
}

async function existingOrConflict(
  tx: SQL,
  id: string,
  requested: HostedBoardCreateContent,
): Promise<HostedBoardMessage | null> {
  const loaded = await loadHostedBoardMessage(tx, id)
  if (!loaded) return null
  const stored = createContent(loaded.row, loaded.tags)
  const sameScalars = sameHostedBoardCreateContent(
    {
      ...stored,
      scopeProjectIds: requested.scopeProjectIds,
      recipientUserIds: requested.recipientUserIds,
    },
    requested,
  )
  if (
    !sameScalars ||
    !(await storedArraysMatch(tx, id, requested.scopeProjectIds, requested.recipientUserIds))
  ) {
    throw new RecordBoardError(
      `board message ${id} already exists with different content; mint a new id`,
      409,
    )
  }
  return hostedBoardMessageView(loaded.row, loaded.tags)
}

export async function postHostedBoardMessage(
  input: BoardTenant & HostedBoardPostInput,
): Promise<HostedBoardMessage> {
  if (input.kind !== 'notice' && input.kind !== 'question') {
    throw new RecordBoardError('hosted board post kind must be notice or question', 400)
  }
  const audience = parseHostedAudience(input.audience)
  const refusal = hostedBoardPostRefusal(input.kind, audience)
  if (refusal) throw new RecordBoardError(refusal, 400)
  asBoardError(() => validatePostNoticeInput(input))
  if (input.kind === 'question' && input.ackRequired) {
    throw new RecordBoardError('a board question cannot require acknowledgement', 400)
  }
  const expiresAt = new Date(input.expiresAt).toISOString()
  const ackRequired = input.ackRequired ?? false
  const ackDeadline = ackRequired
    ? new Date(input.ackDeadline ?? Date.parse(expiresAt) - 1).toISOString()
    : null
  if (ackRequired && !input.ackDeadline) {
    throw new RecordBoardError('an acknowledged board notice requires ackDeadline', 400)
  }
  if (ackDeadline && Date.parse(ackDeadline) > Date.parse(expiresAt)) {
    throw new RecordBoardError(
      'ack deadline is later than expiry; set ackDeadline no later than expiresAt',
      400,
    )
  }
  const session = sessionOrNull(input.authorSession)
  const senderTags = asBoardError(() => senderBoardTags(input))
  const tags = [
    ...senderTags,
    ...inferredBoardTags(input.body, senderTags, input.currentTaskKey ?? null),
  ]
  const clock = Date.now()
  const requested: HostedBoardCreateContent = {
    kind: input.kind,
    audience: input.audience,
    title: input.title,
    body: input.body,
    ackRequired,
    ackDeadline,
    expiresAt,
    threadRootId: null,
    scopeProjectIds: [],
    recipientUserIds: [],
    claimId: null,
    senderTags: senderTags.map(({ kind, value }) => ({ kind, value })),
  }
  return withBoardTenant(input, true, async (tx) => {
    const projectName = hostedProjectNameForAudience(audience, input.project)
    const projectId = projectName ? await resolveVisibleProjectId(tx, projectName) : null
    const derived = hostedBoardScope(audience, projectId)
    requested.scopeProjectIds = derived.scopeProjectIds
    requested.recipientUserIds = derived.recipientUserIds
    const sameId = await existingOrConflict(tx, input.id, requested)
    if (sameId) return sameId
    const duplicateId = await duplicateRootId(
      tx,
      {
        kind: input.kind,
        userId: input.userId,
        session,
        audience: input.audience,
        title: input.title,
        body: input.body,
      },
      senderTags,
      clock,
    )
    const decision = await authorWindow(tx, input.userId, session, clock, duplicateId !== null)
    if (decision === 'drop-duplicate' && duplicateId) return viewById(tx, duplicateId, clock)
    if (decision === 'rate-limited') throw new RecordBoardError(RATE_LIMITED, 429)
    await insertRoot(
      tx,
      { ...input, ackRequired, ackDeadline, expiresAt, authorSession: session },
      input.userId,
      session,
      audience,
      tags,
      clock,
    )
    return viewById(tx, input.id, clock)
  })
}

export async function postHostedBoardNoticeInTransaction(
  tx: SQL,
  input: HostedBoardPostInput & { userId: string },
  clock: number,
  forcedScope?: HostedBoardForcedScope,
): Promise<'rate-limited' | HostedBoardMessage> {
  const audience = parseHostedAudience(input.audience)
  const refusal = hostedBoardPostRefusal(input.kind, audience)
  if (refusal) throw new RecordBoardError(refusal, 400)
  asBoardError(() => validatePostNoticeInput(input))
  const session = sessionOrNull(input.authorSession)
  const senderTags = asBoardError(() => senderBoardTags(input))
  const tags = [
    ...senderTags,
    ...inferredBoardTags(input.body, senderTags, input.currentTaskKey ?? null),
  ]
  const decision = await authorWindow(tx, input.userId, session, clock, false)
  if (decision === 'rate-limited') return 'rate-limited'
  await insertRoot(
    tx,
    { ...input, authorSession: session },
    input.userId,
    session,
    audience,
    tags,
    clock,
    forcedScope,
  )
  return viewById(tx, input.id, clock)
}

function replyBodyRefusal(body: string): string | null {
  if (!body.trim()) return 'board reply body is required; provide body'
  if (body.length > BOARD_BODY_MAX_CHARS)
    return `board reply body exceeds ${BOARD_BODY_MAX_CHARS} characters; shorten it`
  if (containsSecretShaped(body))
    return 'board reply contains secret-shaped text; remove the credential and retry'
  return null
}

function liveRoot(row: Record<string, unknown>, clock: number): boolean {
  if (row.expires_at == null) return false
  return messageIsLive(
    {
      expiresAt: Date.parse(String(row.expires_at)),
      withdrawnAt: row.withdrawn_at ? Date.parse(String(row.withdrawn_at)) : null,
    },
    clock,
  )
}

async function loadThreadRoot(
  tx: SQL,
  id: string,
): Promise<{ row: Record<string, unknown>; tags: BoardTag[] } | null> {
  const loaded = await loadHostedBoardMessage(tx, id)
  if (!loaded) return null
  if (String(loaded.row.kind) !== 'reply') return loaded
  return loadHostedBoardMessage(tx, String(loaded.row.thread_root_id))
}

async function insertReplyCopyingRoot(
  tx: SQL,
  input: BoardTenant & HostedBoardReplyInput & { rootId: string },
  session: string | null,
  rootId: string,
  createdAt: string,
  clock: number,
): Promise<HostedBoardMessage> {
  const inserted = await tx`
    INSERT INTO board_message (
      id, author_user_id, author_session, author_harness, author_machine_id, author_run_id,
      kind, thread_root_id, audience, title, body, ack_required, ack_deadline, expires_at,
      created_at, claim_id, scope_project_ids, recipient_user_ids
    )
    SELECT
      ${input.id}::uuid, ${input.userId}::uuid, ${session}, ${input.authorHarness ?? null},
      ${input.authorMachineId ?? null}::uuid, ${input.authorRunId ?? null}::uuid,
      'reply', root.id, NULL, NULL, ${input.body}, false, NULL, NULL,
      ${createdAt}::timestamptz, NULL, root.scope_project_ids, root.recipient_user_ids
    FROM board_message AS root
    WHERE root.id = ${rootId}::uuid
    RETURNING id
  `
  if (!inserted[0]) throw new RecordBoardError(`board message ${input.rootId} not found`, 404)
  return viewById(tx, input.id, clock)
}

export async function replyHostedBoardMessage(
  input: BoardTenant & HostedBoardReplyInput & { rootId: string },
): Promise<HostedBoardMessage> {
  const bodyRefusal = replyBodyRefusal(input.body)
  if (bodyRefusal) throw new RecordBoardError(bodyRefusal, 400)
  const session = sessionOrNull(input.authorSession)
  const actor = hostedBoardActor(session)
  const clock = Date.now()
  const requested: HostedBoardCreateContent = {
    kind: 'reply',
    audience: null,
    title: null,
    body: input.body,
    ackRequired: false,
    ackDeadline: null,
    expiresAt: null,
    threadRootId: input.rootId,
    scopeProjectIds: [],
    recipientUserIds: [],
    claimId: null,
    senderTags: [],
  }
  return withBoardTenant(input, true, async (tx) => {
    const sameId = await existingOrConflict(tx, input.id, requested)
    if (sameId) return sameId
    const rootRow = await loadThreadRoot(tx, input.rootId)
    if (!rootRow) throw new RecordBoardError(`board message ${input.rootId} not found`, 404)
    const audienceKind = rootRow.row.audience
      ? parseHostedAudience(String(rootRow.row.audience)).kind
      : 'operator'
    const refusal = replyRefusal({
      actor: { kind: actor.kind, reader: input.userId },
      root: {
        id: String(rootRow.row.id),
        kind: String(rootRow.row.kind),
        authorReader: String(rootRow.row.author_user_id),
        audienceKind,
        live: liveRoot(rootRow.row, clock),
        accepted: rootRow.row.accepted_reply_id != null,
      },
      addressed: true,
      hasReceipt: false,
    })
    if (refusal) throw new RecordBoardError(refusal, 400)
    requested.scopeProjectIds = hostedUuidList(rootRow.row.scope_project_ids)
    requested.threadRootId = String(rootRow.row.id)
    requested.recipientUserIds = hostedUuidList(rootRow.row.recipient_user_ids)
    const duplicateSince = new Date(clock - BOARD_DUPLICATE_WINDOW_MS).toISOString()
    const duplicate = (await tx`
      SELECT id FROM board_message
      WHERE kind='reply' AND author_user_id=${input.userId}::uuid
        AND author_session IS NOT DISTINCT FROM ${session}
        AND thread_root_id=${String(rootRow.row.id)}::uuid AND body=${input.body}
        AND created_at>=${duplicateSince}::timestamptz
      ORDER BY created_at DESC LIMIT 1
    `) as { id: string }[]
    const decision = await authorWindow(tx, input.userId, session, clock, duplicate.length > 0)
    if (decision === 'drop-duplicate' && duplicate[0])
      return viewById(tx, String(duplicate[0].id), clock)
    if (decision === 'rate-limited') throw new RecordBoardError(RATE_LIMITED, 429)
    return insertReplyCopyingRoot(
      tx,
      input,
      session,
      String(rootRow.row.id),
      new Date(clock).toISOString(),
      clock,
    )
  })
}

export async function withdrawHostedBoardMessage(
  input: BoardTenant & HostedBoardSessionInput & { id: string },
): Promise<HostedBoardMessage> {
  const clock = Date.now()
  return withBoardTenant(input, true, async (tx) => {
    const loaded = await loadHostedBoardMessage(tx, input.id)
    if (!loaded) throw new RecordBoardError(`board message ${input.id} not found`, 404)
    if (String(loaded.row.author_user_id) !== input.userId) {
      throw new RecordBoardError(`only the author may withdraw board message ${input.id}`, 403)
    }
    if (String(loaded.row.kind) === 'reply') {
      throw new RecordBoardError(
        `board message ${input.id} is a reply; withdraw its root instead`,
        400,
      )
    }
    if (loaded.row.withdrawn_at != null)
      return hostedBoardMessageView(loaded.row, loaded.tags, clock)
    await tx`
      UPDATE board_message SET withdrawn_at=${new Date(clock).toISOString()}::timestamptz
      WHERE id=${input.id}::uuid
    `
    return viewById(tx, input.id, clock)
  })
}

export async function acceptHostedBoardAnswer(
  input: BoardTenant & { id: string; replyId: string; authorSession?: string | null },
): Promise<HostedBoardThread> {
  const clock = Date.now()
  sessionOrNull(input.authorSession)
  return withBoardTenant(input, true, async (tx) => {
    const question = await loadHostedBoardMessage(tx, input.id)
    if (!question) throw new RecordBoardError(`board message ${input.id} not found`, 404)
    const refusal = acceptRefusal({
      actor: { kind: 'architect', reader: input.userId },
      questionId: input.id,
      questionKind: String(question.row.kind),
      authorReader: String(question.row.author_user_id),
      accepted: question.row.accepted_reply_id != null,
      live: liveRoot(question.row, clock),
    })
    if (refusal) throw new RecordBoardError(refusal, 400)
    const reply = await loadHostedBoardMessage(tx, input.replyId)
    if (
      !reply ||
      String(reply.row.kind) !== 'reply' ||
      String(reply.row.thread_root_id) !== input.id
    ) {
      throw new RecordBoardError(
        `board reply ${input.replyId} does not belong to board question ${input.id}`,
        400,
      )
    }
    await tx`
      UPDATE board_message
      SET accepted_reply_id=${input.replyId}::uuid,
          accepted_by_user_id=${input.userId}::uuid,
          accepted_at=${new Date(clock).toISOString()}::timestamptz,
          note_pending_error=${'note filing has not completed'}
      WHERE id=${input.id}::uuid
    `
    return readThreadInTx(tx, input.id, clock)
  })
}

async function readThreadInTx(tx: SQL, id: string, clock: number): Promise<HostedBoardThread> {
  const loaded = await loadHostedBoardMessage(tx, id)
  if (!loaded) throw new RecordBoardError(`board message ${id} not found`, 404)
  const rootId =
    String(loaded.row.kind) === 'reply' ? String(loaded.row.thread_root_id) : String(loaded.row.id)
  const root = rootId === String(loaded.row.id) ? loaded : await loadHostedBoardMessage(tx, rootId)
  if (!root) throw new RecordBoardError(`board message ${id} not found`, 404)
  const replies = (await tx`
    SELECT * FROM board_message WHERE thread_root_id=${rootId}::uuid ORDER BY created_at, id
  `) as Record<string, unknown>[]
  return {
    root: hostedBoardMessageView(root.row, root.tags, clock),
    replies: replies.map(hostedBoardReplyView),
  }
}

export async function readHostedBoardThread(
  input: BoardTenant & { id: string },
): Promise<HostedBoardThread> {
  return withBoardTenant(input, false, (tx) => readThreadInTx(tx, input.id, Date.now()))
}

function filingLeaseError(question: Record<string, unknown>, clock: number): string | null {
  const decision = noteFilingLeaseDecision(
    question.note_id == null ? null : 1,
    question.note_filing_started_at == null ? null : String(question.note_filing_started_at),
    clock,
  )
  if (decision.kind === 'filed')
    return `board question ${String(question.id)} already filed note ${String(question.note_id)}`
  if (decision.kind === 'in-progress')
    return `board question ${String(question.id)} note filing is in progress; retry after ${new Date(decision.retryAt).toISOString()}`
  return null
}

export async function takeHostedBoardFilingLease(
  input: BoardTenant & HostedBoardSessionInput & { id: string },
): Promise<HostedBoardMessage> {
  const clock = Date.now()
  sessionOrNull(input.authorSession)
  return withBoardTenant(input, true, async (tx) => {
    const question = await loadHostedBoardMessage(tx, input.id)
    if (!question) throw new RecordBoardError(`board message ${input.id} not found`, 404)
    if (String(question.row.kind) !== 'question' || question.row.accepted_reply_id == null) {
      throw new RecordBoardError(`board question ${input.id} has no accepted answer to file`, 400)
    }
    if (String(question.row.author_user_id) !== input.userId) {
      throw new RecordBoardError(
        `only the question author or operator may file a note for board question ${input.id}`,
        403,
      )
    }
    const refusal = filingLeaseError(question.row, clock)
    if (refusal) throw new RecordBoardError(refusal, 409)
    const startedAt = new Date(clock).toISOString()
    const staleBefore = new Date(clock - BOARD_NOTE_FILING_LEASE_MS).toISOString()
    const updated = await tx`
      UPDATE board_message SET note_filing_started_at=${startedAt}::timestamptz
      WHERE id=${input.id}::uuid AND note_id IS NULL
        AND (note_filing_started_at IS NULL OR note_filing_started_at<=${staleBefore}::timestamptz)
      RETURNING id
    `
    if (!updated[0]) {
      const raced = await loadHostedBoardMessage(tx, input.id)
      throw new RecordBoardError(
        (raced ? filingLeaseError(raced.row, clock) : null) ??
          `board question ${input.id} note filing is in progress`,
        409,
      )
    }
    return viewById(tx, input.id, clock)
  })
}

export async function completeHostedBoardFilingLease(
  input: BoardTenant & { id: string; noteId: string; authorSession?: string | null },
): Promise<HostedBoardMessage> {
  sessionOrNull(input.authorSession)
  return withBoardTenant(input, true, async (tx) => {
    const question = await loadHostedBoardMessage(tx, input.id)
    if (!question) throw new RecordBoardError(`board message ${input.id} not found`, 404)
    if (String(question.row.author_user_id) !== input.userId) {
      throw new RecordBoardError(
        `only the question author or operator may file a note for board question ${input.id}`,
        403,
      )
    }
    await tx`
      UPDATE board_message
      SET note_id=${input.noteId}::uuid, note_pending_error=NULL, note_filing_started_at=NULL
      WHERE id=${input.id}::uuid
    `
    return viewById(tx, input.id, Date.now())
  })
}

export async function failHostedBoardFilingLease(
  input: BoardTenant & { id: string; error: string; authorSession?: string | null },
): Promise<HostedBoardMessage> {
  sessionOrNull(input.authorSession)
  if (!input.error.trim()) throw new RecordBoardError('filing failure error is required', 400)
  return withBoardTenant(input, true, async (tx) => {
    const question = await loadHostedBoardMessage(tx, input.id)
    if (!question) throw new RecordBoardError(`board message ${input.id} not found`, 404)
    if (String(question.row.author_user_id) !== input.userId) {
      throw new RecordBoardError(
        `only the question author or operator may file a note for board question ${input.id}`,
        403,
      )
    }
    await tx`
      UPDATE board_message
      SET note_pending_error=${input.error}, note_filing_started_at=NULL
      WHERE id=${input.id}::uuid
    `
    return viewById(tx, input.id, Date.now())
  })
}
