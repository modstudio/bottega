import type { Database } from 'bun:sqlite'
import { hostname } from 'node:os'
import type { BoardPurpose } from '../../../shared/board-purpose.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { SESSION_LIVE_MS } from '../../../shared/session-liveness.ts'
import { classifyCaller } from '../caller-classification.ts'
import { db, nowIso, writableDb, writeTransaction } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import {
  BOARD_READ_REFRESH_BUDGET_MS,
  cachedHostedBoardMessages,
  claimCachedHosted,
  reapHostedBoardCache,
  refreshHostedBoard,
} from './board-hosted-cache.ts'
import { cachedHostedBoardReceiptFacts } from './board-hosted-cache-readers.ts'
import {
  HOSTED_BOARD_PRODUCT_STOPPED_REMEDY,
  hostedBoardRefreshStoppedReason,
  hostedBoardStoppedMessage,
} from './board-hosted-refresh-message.ts'
import { requireLocalBoardRead, requireLocalBoardWrite } from './board-local-read-guard.ts'
import { type BoardLocality, boardHasAdoptedHosted, boardMode } from './board-mode.ts'
import {
  architectIdentity,
  messageCanBeReaped,
  needsAckEscalation,
  OPERATOR_READER,
  parseAudience,
  requireRealSession,
} from './board-policy.ts'
import {
  type DeferredReplySuccessor,
  missingReaderStartWarning,
  type ReplySuccessorNoticeState,
  replySuccessorAddressing,
  selectPushNotices,
} from './board-push-policy.ts'
import { renewLiveQueuedClaimsOfSession } from './board-queued-claim-renewal.ts'
import { renderBoardNotice, renderBoardNoticeOneLine } from './board-render.ts'
import {
  addressed,
  boardActor,
  boardOrigin,
  boardReaderBeganAt,
  type Environment,
  hasNonSuccessorReceipt,
  hasReceipt,
  holdsReplySuccessor,
  insertRootMessage,
  type MessageRow,
  machineMessageRows,
  messageRows,
  messageTags,
  originText,
  type PostNoticeInput,
  type PostNoticeResult,
  presenceFacts,
  recipients,
  rowIsLive,
} from './board-store.ts'
import {
  renderBoardQuestion,
  renderBoardReply,
  renderBoardReplyDelivery,
} from './board-thread-render.ts'

export { requireRealSession } from './board-policy.ts'

export type { PostNoticeInput, PostNoticeResult }
export { boardActor }

/** Local board rows remain machine-scoped after this store adopts the hosted board. */
export function localBoardRows(database: Database = db()): MessageRow[] {
  return boardHasAdoptedHosted(database) ? machineMessageRows(database) : messageRows(database)
}

function boardReader(env: Environment = process.env): string {
  const actor = boardActor(env)
  return actor.session ?? OPERATOR_READER
}

function rowLocality(row: MessageRow): BoardLocality {
  return row.audience && parseAudience(row.audience).kind === 'machine'
    ? 'machine-audience'
    : 'shared'
}

function rowsLocality(rows: MessageRow[]): BoardLocality {
  return rows.length > 0 && rows.every((row) => rowLocality(row) === 'machine-audience')
    ? 'machine-audience'
    : 'shared'
}

export function recordPresence(
  cwd = process.cwd(),
  env: Environment = process.env,
  at = nowIso(),
  beganAt?: string,
): boolean {
  if (classifyCaller(env).kind === 'worker') return false
  if (
    env.CLAUDE_CODE_SESSION_ID?.trim() === OPERATOR_READER ||
    env.CLAUDE_CODE_SESSION_ID?.trim().startsWith('run:')
  )
    throw new Error(
      'operator and run:<id> readers are reserved; use a real architect session id or address the worker with run:<id>',
    )
  const identity = architectIdentity(env)
  if (!identity) return false
  if (identity.session === OPERATOR_READER || identity.session.startsWith('run:'))
    throw new Error(
      'operator and run:<id> readers are reserved; use a real architect session id or address the worker with run:<id>',
    )
  const project = projectAt(cwd)
  if (!project)
    throw new Error(`no registered project contains ${cwd}; run ${PLATFORM_SLUG} project add first`)
  const current = db()
    .query(
      `SELECT launch_key,task_record_id FROM run
       WHERE session_id=? AND status IN ('running','asking') AND launch_key IS NOT NULL
       ORDER BY number DESC LIMIT 1`,
    )
    .get(identity.session) as { launch_key: string; task_record_id: string | null } | null
  writableDb()
    .query(
      `INSERT INTO presence
       (session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,current_task_record_id,first_seen,last_seen)
       VALUES (?,?,'architect',?,?,?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET harness=excluded.harness, role=excluded.role,
         machine=excluded.machine, project=excluded.project,
         project_record_id=excluded.project_record_id, cwd=excluded.cwd,
         current_task_key=excluded.current_task_key,
         current_task_record_id=excluded.current_task_record_id, last_seen=excluded.last_seen`,
    )
    .run(
      identity.session,
      identity.harness,
      hostname(),
      project.name,
      project.recordId,
      cwd,
      current?.launch_key ?? null,
      current?.task_record_id ?? null,
      beganAt ?? at,
      at,
    )
  const database = writableDb()
  if (boardMode('shared', env, database) === 'local')
    renewLiveQueuedClaimsOfSession(identity.session, Date.parse(at), database)
  return true
}

export function postNotice(
  input: PostNoticeInput,
  env: Environment = process.env,
  clock = Date.now(),
  cwd = process.cwd(),
): PostNoticeResult {
  const database = writableDb()
  requireLocalBoardWrite(
    'notice post',
    env,
    database,
    parseAudience(input.audience).kind === 'machine' ? 'machine-audience' : 'shared',
  )
  return writeTransaction(() => postNoticeInTransaction(input, env, clock, cwd, database), database)
}

export function postNoticeInTransaction(
  input: PostNoticeInput,
  env: Environment,
  clock: number,
  cwd: string,
  database: ReturnType<typeof writableDb>,
): PostNoticeResult {
  return insertRootMessage('notice', input, env, clock, cwd, database)
}

function rootRunRecordId(runId: string, database = db()): string | null {
  const row = database
    .query('SELECT COALESCE(parent_run_record_id,record_id) root_id FROM run WHERE record_id=?')
    .get(runId) as { root_id: string } | null
  return row?.root_id ?? null
}

function runReader(rootRunRecordId: string): string {
  return `run:${rootRunRecordId}`
}

export function runReaderIdentity(runId: string, database = db()) {
  const readerRunRecordId = rootRunRecordId(runId, database)
  if (!readerRunRecordId) throw new Error(`no run ${runId}; use a live orchestrator run id`)
  return { reader: runReader(readerRunRecordId), readerRunRecordId }
}

function receiptDelivery(
  messageRecordId: string,
  reader: string,
  database = db(),
  locality: BoardLocality = 'shared',
) {
  requireLocalBoardRead(process.env, database, locality)
  return database
    .query('SELECT delivered_at FROM board_receipt WHERE message_record_id=? AND reader_session=?')
    .get(messageRecordId, reader) as { delivered_at: string | null } | null
}

function wasDelivered(
  messageRecordId: string,
  reader: string,
  database = db(),
  locality: BoardLocality = 'shared',
): boolean {
  return Boolean(receiptDelivery(messageRecordId, reader, database, locality)?.delivered_at)
}

function replySuccessorPush(
  reply: MessageRow,
  reader: string,
  clock: number,
  database: Database,
  locality: BoardLocality = 'shared',
): boolean {
  requireLocalBoardRead(process.env, database, locality)
  if (reply.kind !== 'reply' || reply.thread_root_record_id === null) return false
  const root = messageRows(database).find(
    (candidate) => candidate.record_id === reply.thread_root_record_id,
  )
  if (!root?.author_session || !root.author_project) return false
  return replySuccessorAddressing({
    presence: presenceFacts(database, clock),
    reader,
    rootAuthorSession: root.author_session,
    rootAuthorReceivedReply: wasDelivered(reply.record_id, root.author_session, database, locality),
    rootProject: root.author_project,
    readerIsParticipant: hasNonSuccessorReceipt(reply.record_id, reader, database, locality),
    successorClaimed: Boolean(
      database
        .query(
          `SELECT 1 AS ok FROM board_receipt
           WHERE message_record_id=? AND successor=1 AND reader_session<>?`,
        )
        .get(reply.record_id, reader),
    ),
    readerBeganAt: boardReaderBeganAt(reader, database),
    replyPostedAt: reply.created_at,
    now: clock,
    liveWindowMs: SESSION_LIVE_MS,
  })
}

function takeReportReplySuccessor(
  reply: MessageRow,
  reader: string,
  clock: number,
  database: Database,
): boolean {
  requireLocalBoardWrite('notice delivery', process.env, database)
  return writeTransaction(() => {
    if (!replySuccessorPush(reply, reader, clock, database)) return false
    database
      .query(
        `INSERT INTO board_receipt
         (message_record_id,reader_session,audience_at_posting,successor,delivered_at,acknowledged_at,record_id)
         VALUES (?,?,0,1,NULL,NULL,?) ON CONFLICT(message_record_id,reader_session) DO UPDATE SET
         delivered_at=COALESCE(board_receipt.delivered_at,excluded.delivered_at),
         successor=1`,
      )
      .run(reply.record_id, reader, newRecordId())
    return true
  }, database)
}

export function deliverableTo(
  message: MessageRow,
  reader: string,
  clock: number,
  database = db(),
  locality: BoardLocality = 'shared',
): boolean {
  return message.kind === 'reply'
    ? hasReceipt(message.record_id, reader, database, locality) ||
        replySuccessorPush(message, reader, clock, database, locality)
    : addressed(message, reader, clock, database, locality)
}

function render(
  message: MessageRow,
  worker = false,
  database = db(),
  locality: BoardLocality = 'shared',
) {
  const tags = messageTags(message.record_id, database, locality)
  if (message.kind === 'reply') {
    const root = messageRows(database).find(
      (candidate) => candidate.record_id === message.thread_root_record_id,
    )
    if (!root?.title) throw new Error(`board reply ${message.number} has no thread root`)
    return {
      number: message.number,
      recordId: message.record_id,
      text: renderBoardReply({
        id: message.number,
        origin: originText(boardOrigin(message)),
        rootId: root.record_id,
        rootTitle: root.title,
        body: message.body,
      }),
      oneLine: renderBoardReplyDelivery({
        origin: originText(boardOrigin(message)),
        rootId: root.record_id,
        rootTitle: root.title,
        body: message.body,
      }),
      threadTitle: root.title,
      purpose: 'information' as const,
    }
  }
  if (message.kind === 'question') {
    return {
      number: message.number,
      recordId: message.record_id,
      text: renderBoardQuestion({
        id: message.number,
        origin: originText(boardOrigin(message)),
        title: message.title ?? '',
        body: message.body,
        expiresAt: message.expires_at ?? '',
        tags: tags
          .filter((tag) => tag.origin === 'sender')
          .map((tag) => `${tag.kind}:${tag.value}`),
      }),
      oneLine: renderBoardNoticeOneLine({
        id: message.number,
        title: message.title ?? '',
        sender: originText(boardOrigin(message)),
        ackRequired: false,
      }),
      purpose: 'request' as const,
    }
  }
  return {
    number: message.number,
    recordId: message.record_id,
    text: renderBoardNotice({
      id: message.number,
      kind: message.kind,
      purpose: message.purpose ?? 'information',
      authorKind: message.author_kind,
      authorSession: message.author_session,
      authorHarness: message.author_harness,
      authorProject: message.author_project,
      authorRunId: message.author_run_record_id,
      title: message.title ?? '',
      body: message.body,
      expiresAt: message.expires_at ?? '',
      ackRequired: message.ack_required === 1,
      tags: tags.filter((tag) => tag.origin === 'sender'),
      worker,
    }),
    oneLine: renderBoardNoticeOneLine({
      id: message.number,
      title: message.title ?? '',
      sender: originText(boardOrigin(message)),
      ackRequired: message.ack_required === 1,
    }),
    purpose: message.purpose ?? 'information',
  }
}

export function claimRunNotices(
  runId: string,
  all = false,
  clock = Date.now(),
  database = db(),
): {
  number: number
  recordId: string
  text: string
  oneLine: string
  ackRequired: boolean
  ackDeadline: string | null
  createdAt: string
  expiresAt: string | null
  purpose: BoardPurpose
}[] {
  const { reader } = runReaderIdentity(runId, database)
  return messageRows(database)
    .filter(
      (row) =>
        row.kind === 'notice' &&
        rowIsLive(row, clock, database) &&
        addressed(row, reader, clock, database) &&
        (all || !wasDelivered(row.record_id, reader, database)),
    )
    .map((row) => ({
      ...render(row, true, database),
      ackRequired: row.ack_required === 1,
      ackDeadline: row.ack_deadline,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }))
}

export function claimRunPushNotices(
  runId: string,
  all = false,
  clock = Date.now(),
  database = db(),
): {
  notices: ReturnType<typeof claimRunNotices>
  withheldOlderCount: number
  warning: string | null
} {
  const readerRunRecordId = rootRunRecordId(runId, database)
  if (!readerRunRecordId) {
    const selected = selectPushNotices('unbounded', [], clock)
    return {
      notices: selected.notices,
      withheldOlderCount: selected.withheldOlderCount,
      warning: missingReaderStartWarning(runReader(runId)),
    }
  }
  const reader = runReader(readerRunRecordId)
  const beganAt = boardReaderBeganAt(reader, database, readerRunRecordId)
  const selected = selectPushNotices(beganAt, claimRunNotices(runId, all, clock, database), clock)
  return {
    notices: selected.notices,
    withheldOlderCount: selected.withheldOlderCount,
    warning: beganAt === null ? missingReaderStartWarning(reader) : null,
  }
}

export function markRunNoticesDelivered(
  runId: string,
  ids: string[],
  clock = Date.now(),
  sourceRows: MessageRow[] = messageRows(),
): void {
  const { reader, readerRunRecordId } = runReaderIdentity(runId)
  const idSet = new Set(ids)
  const locality = rowsLocality(sourceRows)
  const rows = sourceRows.filter(
    (row) =>
      row.kind === 'notice' &&
      idSet.has(row.record_id) &&
      rowIsLive(row, clock) &&
      addressed(row, reader, clock, db(), locality),
  )
  if (!rows.length) return
  const database = writableDb()
  requireLocalBoardWrite('notice delivery', process.env, database, locality)
  const deliveredAt = new Date(clock).toISOString()
  writeTransaction(() => {
    const stamp = database.query(
      `INSERT INTO board_receipt
       (message_record_id,reader_session,reader_run_record_id,audience_at_posting,delivered_at,acknowledged_at,record_id)
       VALUES (?,?,?,0,?,NULL,?) ON CONFLICT(message_record_id,reader_session) DO UPDATE SET
       reader_run_record_id=COALESCE(board_receipt.reader_run_record_id,excluded.reader_run_record_id),
       delivered_at=COALESCE(board_receipt.delivered_at,excluded.delivered_at)`,
    )
    for (const row of rows)
      stamp.run(row.record_id, reader, readerRunRecordId, deliveredAt, newRecordId())
  }, database)
}

export function claimNotices(
  all = false,
  env: Environment = process.env,
  clock = Date.now(),
  database = db(),
  sourceRows: MessageRow[] = messageRows(database),
): ({
  number: number
  recordId: string
  text: string
  oneLine: string
  ackRequired: boolean
  ackDeadline: string | null
  createdAt: string
  expiresAt: string | null
  purpose: BoardPurpose
  threadTitle?: string
} & ReplySuccessorNoticeState)[] {
  const reader = boardReader(env)
  const locality = rowsLocality(sourceRows)
  const rows = sourceRows.filter(
    (row) =>
      row.author_session !== reader &&
      rowIsLive(row, clock, database) &&
      deliverableTo(row, reader, clock, database, locality) &&
      (all || !wasDelivered(row.record_id, reader, database, locality)),
  )
  return rows.map((row) => {
    const notice = {
      ...render(row, false, database, locality),
      ackRequired: row.ack_required === 1,
      ackDeadline: row.ack_deadline,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
    return row.kind === 'reply' && replySuccessorPush(row, reader, clock, database, locality)
      ? {
          ...notice,
          reportReplySuccessor: true,
          successorHeld: holdsReplySuccessor(row.record_id, reader, database, locality),
        }
      : notice
  })
}

export function claimPushNotices(
  all = false,
  env: Environment = process.env,
  clock = Date.now(),
  database: Database = writableDb(),
  claimReplySuccessors = true,
  sourceRows: MessageRow[] = messageRows(database),
): {
  notices: ReturnType<typeof claimNotices>
  withheldOlderCount: number
  deferredReplySuccessorCount: number
  deferredReplySuccessors: DeferredReplySuccessor[]
  warning: string | null
} {
  const reader = boardReader(env)
  const beganAt =
    reader === OPERATOR_READER ? ('unbounded' as const) : boardReaderBeganAt(reader, database)
  const selected = selectPushNotices(
    beganAt,
    claimNotices(all, env, clock, database, sourceRows),
    clock,
    claimReplySuccessors,
  )
  const notices = selected.notices.filter((notice) => {
    if (!notice.reportReplySuccessor) return true
    const row = sourceRows.find((item) => item.record_id === notice.recordId)
    return row !== undefined && takeReportReplySuccessor(row, reader, clock, database)
  })
  return {
    notices,
    withheldOlderCount: selected.withheldOlderCount,
    deferredReplySuccessorCount: selected.deferredReplySuccessorCount,
    deferredReplySuccessors: selected.deferredReplySuccessors.map((notice) => ({
      replyRecordId: notice.recordId,
      threadTitle: notice.threadTitle!,
    })),
    warning:
      reader !== OPERATOR_READER && beganAt === null ? missingReaderStartWarning(reader) : null,
  }
}

export function markNoticesDelivered(
  ids: string[],
  env: Environment = process.env,
  clock = Date.now(),
  database: Database = writableDb(),
  sourceRows: MessageRow[] = messageRows(database),
): void {
  const reader = boardReader(env)
  const idSet = new Set(ids)
  const locality = rowsLocality(sourceRows)
  const rows = sourceRows.filter(
    (row) =>
      idSet.has(row.record_id) &&
      row.author_session !== reader &&
      rowIsLive(row, clock, database) &&
      deliverableTo(row, reader, clock, database, locality),
  )
  if (!rows.length) return
  requireLocalBoardWrite('notice delivery', env, database, locality)
  const deliveredAt = new Date(clock).toISOString()
  writeTransaction(() => {
    const stamp = database.query(
      `INSERT INTO board_receipt
       (message_record_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,record_id)
       VALUES (?,?,0,?,NULL,?) ON CONFLICT(message_record_id,reader_session) DO UPDATE SET
       delivered_at=COALESCE(board_receipt.delivered_at,excluded.delivered_at)`,
    )
    for (const row of rows) stamp.run(row.record_id, reader, deliveredAt, newRecordId())
  }, database)
}

export function readNotices(
  all = false,
  env: Environment = process.env,
  clock = Date.now(),
): {
  number: number
  recordId: string
  text: string
  oneLine: string
  ackRequired: boolean
  createdAt: string
  purpose: BoardPurpose
}[] {
  const notices = claimNotices(all, env, clock)
  markNoticesDelivered(
    notices.map((notice) => notice.recordId),
    env,
    clock,
  )
  return notices
}

export type BoardRequestCount = number | { unread: string }

export async function boardRequestCountForSession(
  session: string,
  env: Environment = process.env,
  database: Database = db(),
  refresh: typeof refreshHostedBoard = refreshHostedBoard,
): Promise<BoardRequestCount> {
  const boardEnv = { ...env, CLAUDE_CODE_SESSION_ID: session }
  if (boardMode('shared', boardEnv, database) === 'local')
    return claimNotices(true, boardEnv, Date.now(), database).filter(
      (notice) => notice.purpose === 'request',
    ).length
  const refreshed = await refresh({
    budgetMs: BOARD_READ_REFRESH_BUDGET_MS,
    env: boardEnv,
    database,
  })
  if (refreshed.status === 'success')
    return claimCachedHosted(session, true, Date.now(), database).filter(
      (notice) => notice.purpose === 'request',
    ).length
  return {
    unread: hostedBoardRefreshStoppedReason(refreshed),
  }
}

export function acknowledgeNotice(
  id: string,
  env: Environment = process.env,
  clock = Date.now(),
  sourceRows: MessageRow[] = messageRows(),
) {
  const reader = boardReader(env)
  const row = sourceRows.find((candidate) => candidate.record_id === id)
  if (!row) throw new Error(`live board notice ${id} is not addressed to this reader`)
  const locality = rowLocality(row)
  if (!rowIsLive(row, clock) || !addressed(row, reader, clock, db(), locality))
    throw new Error(`live board notice ${id} is not addressed to this reader`)
  const database = writableDb()
  requireLocalBoardWrite('notice acknowledge', env, database, locality)
  database
    .query(
      `INSERT INTO board_receipt
       (message_record_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,record_id)
       VALUES (?,?,0,?,?,?) ON CONFLICT(message_record_id,reader_session) DO UPDATE SET
       delivered_at=COALESCE(board_receipt.delivered_at,excluded.delivered_at),
       acknowledged_at=excluded.acknowledged_at`,
    )
    .run(
      row.record_id,
      reader,
      new Date(clock).toISOString(),
      new Date(clock).toISOString(),
      newRecordId(),
    )
}

export function noticeStatus(
  id: string,
  env: Environment = process.env,
  clock = Date.now(),
  database: Database = db(),
  sourceRows: MessageRow[] = messageRows(database),
) {
  const actor = boardActor(env)
  const row = sourceRows.find((candidate) => candidate.record_id === id)
  if (!row) throw new Error(`no board notice ${id}`)
  const locality = rowLocality(row)
  requireLocalBoardRead(env, database, locality)
  if (
    actor.kind !== 'operator' &&
    actor.session !== row.author_session &&
    !addressed(row, actor.session, clock, database, locality)
  )
    throw new Error(`board notice ${id} was not authored by or addressed to this session`)
  const receipts = database
    .query(
      `SELECT reader_session,reader_run_record_id,audience_at_posting,delivered_at,acknowledged_at FROM board_receipt
       WHERE message_record_id=? ORDER BY reader_session`,
    )
    .all(row.record_id) as {
    reader_session: string
    reader_run_record_id: string | null
    audience_at_posting: number
    delivered_at: string | null
    acknowledged_at: string | null
  }[]
  const unresolved = new Set(
    row.ack_required && row.audience && parseAudience(row.audience).kind === 'machine'
      ? recipients(row.audience, clock, messageTags(row.record_id, database, locality))
      : [],
  )
  for (const receipt of receipts) {
    if (receipt.reader_run_record_id !== null) continue
    if (receipt.acknowledged_at) unresolved.delete(receipt.reader_session)
    else unresolved.add(receipt.reader_session)
  }
  return {
    message: render(row, false, database, locality),
    row,
    tags: messageTags(row.record_id, database, locality),
    receipts,
    reached: receipts.length,
    acknowledged: receipts.filter((receipt) => receipt.acknowledged_at !== null).length,
    unacknowledged: row.ack_required
      ? [...unresolved]
          .filter(
            (reader) =>
              !receipts.some(
                (receipt) =>
                  receipt.reader_session === reader && receipt.reader_run_record_id !== null,
              ),
          )
          .sort()
      : [],
  }
}

export function withdrawNotice(
  id: string,
  env: Environment = process.env,
  clock = Date.now(),
  database: Database = writableDb(),
  sourceRows: MessageRow[] = messageRows(database),
) {
  const actor = boardActor(env)
  const row = sourceRows.find((candidate) => candidate.record_id === id)
  if (!row) throw new Error(`no board notice ${id}`)
  requireLocalBoardWrite('notice withdraw', env, database, rowLocality(row))
  if (actor.kind !== 'operator' && actor.session !== row.author_session)
    throw new Error(`only the notice author or operator may withdraw board notice ${id}`)
  database
    .query(
      "UPDATE board_message SET withdrawn_reason=CASE WHEN withdrawn_at IS NULL THEN 'author' ELSE withdrawn_reason END,withdrawn_at=COALESCE(withdrawn_at,?) WHERE record_id=?",
    )
    .run(new Date(clock).toISOString(), row.record_id)
}

export function markSessionMessagesDelivered(
  session: string,
  ids: string[],
  at = nowIso(),
  locality: BoardLocality = 'shared',
) {
  requireRealSession(session, 'board delivery acknowledgement')
  if (ids.length === 0) return
  const database = writableDb()
  requireLocalBoardWrite('notice delivery', process.env, database, locality)
  for (const id of ids)
    database
      .query(
        `INSERT INTO board_receipt
         (message_record_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,record_id)
         VALUES (?,?,0,?,NULL,?) ON CONFLICT(message_record_id,reader_session) DO UPDATE SET
         delivered_at=COALESCE(board_receipt.delivered_at,excluded.delivered_at)`,
      )
      .run(id, session, at, newRecordId())
}

type BoardEscalationRow = {
  id: string | number
  ackRequired: boolean
  ackDeadline: string | null
  expiresAt: string | null
  withdrawnAt: string | null
  readerSession: string
  readerRunRecordId: string | null
  acknowledgedAt: string | null
  audienceAtPosting: boolean
}

async function boardEscalationRows(
  database: Database,
  env: Environment,
  refresh: typeof refreshHostedBoard,
): Promise<BoardEscalationRow[]> {
  if (boardMode('shared', env, database) === 'hosted') {
    const refreshed = await refresh({
      budgetMs: BOARD_READ_REFRESH_BUDGET_MS,
      env,
      database,
    })
    if (refreshed.status !== 'success')
      throw new Error(
        hostedBoardStoppedMessage(
          'acknowledgement read',
          refreshed,
          HOSTED_BOARD_PRODUCT_STOPPED_REMEDY,
        ),
      )
    const messages = cachedHostedBoardMessages(database)
    return messages.flatMap((message) =>
      cachedHostedBoardReceiptFacts(message.id, database).map((receipt) => ({
        id: message.id,
        ackRequired: message.ackRequired,
        ackDeadline: message.ackDeadline,
        expiresAt: message.expiresAt,
        withdrawnAt: message.withdrawnAt,
        readerSession: receipt.readerSession,
        readerRunRecordId: receipt.readerRunRecordId,
        acknowledgedAt: receipt.acknowledgedAt,
        audienceAtPosting: receipt.audienceAtPosting,
      })),
    )
  }
  return (
    database
      .query(
        `SELECT m.number,m.ack_required,m.ack_deadline,m.expires_at,m.withdrawn_at,r.reader_session,r.reader_run_record_id,
              r.acknowledged_at,r.audience_at_posting
       FROM board_message m JOIN board_receipt r ON r.message_record_id=m.record_id
      `,
      )
      .all() as {
      number: number
      ack_required: number
      ack_deadline: string | null
      expires_at: string
      withdrawn_at: string | null
      reader_session: string
      reader_run_record_id: string | null
      acknowledged_at: string | null
      audience_at_posting: number
    }[]
  ).map((row) => ({
    id: row.number,
    ackRequired: row.ack_required === 1,
    ackDeadline: row.ack_deadline,
    expiresAt: row.expires_at,
    withdrawnAt: row.withdrawn_at,
    readerSession: row.reader_session,
    readerRunRecordId: row.reader_run_record_id,
    acknowledgedAt: row.acknowledged_at,
    audienceAtPosting: row.audience_at_posting === 1,
  }))
}

export async function boardEscalations(
  clock = Date.now(),
  options: {
    env?: Environment
    database?: Database
    refresh?: typeof refreshHostedBoard
  } = {},
) {
  const rows = await boardEscalationRows(
    options.database ?? db(),
    options.env ?? process.env,
    options.refresh ?? refreshHostedBoard,
  )
  return rows
    .filter(
      (row) =>
        row.readerRunRecordId === null &&
        row.expiresAt !== null &&
        needsAckEscalation({
          ackRequired: row.ackRequired,
          deadline: row.ackDeadline ? Date.parse(row.ackDeadline) : null,
          expiresAt: Date.parse(row.expiresAt),
          withdrawnAt: row.withdrawnAt ? Date.parse(row.withdrawnAt) : null,
          acknowledgedAt: row.acknowledgedAt ? Date.parse(row.acknowledgedAt) : null,
          audienceAtPosting: row.audienceAtPosting,
          now: clock,
        }),
    )
    .map((row) => ({
      kind: 'board-ack-overdue',
      subject: `board:${row.id}:${row.readerSession}`,
      since: row.ackDeadline,
      ageMs: row.ackDeadline ? clock - Date.parse(row.ackDeadline) : null,
      detail: `Board notice ${row.id} is not acknowledged by ${row.readerSession}`,
      action: `inspect with ${PLATFORM_SLUG} board status ${row.id}`,
    }))
}

export function reapBoardMessages(clock = Date.now()): number {
  requireLocalBoardWrite('notice reap')
  const rows = messageRows()
  const acceptedRoots = new Set(
    rows
      .filter((row) => row.kind === 'question' && row.accepted_reply_record_id !== null)
      .map((row) => row.record_id),
  )
  const ids = rows
    .filter(
      (row) =>
        !acceptedRoots.has(row.record_id) &&
        (row.thread_root_record_id === null || !acceptedRoots.has(row.thread_root_record_id)),
    )
    .filter((row) =>
      row.expires_at === null
        ? false
        : messageCanBeReaped(
            {
              expiresAt: Date.parse(row.expires_at),
              withdrawnAt: row.withdrawn_at ? Date.parse(row.withdrawn_at) : null,
            },
            clock,
          ),
    )
    .map((row) => row.record_id)
  const remove = writableDb().query('DELETE FROM board_message WHERE record_id=?')
  let reaped = 0
  for (const id of ids) reaped += remove.run(id).changes
  return reaped + reapHostedBoardCache(clock)
}

export function reapBoardMessagesForInstall(
  env: Environment = process.env,
  clock = Date.now(),
): number {
  return boardMode('shared', env) === 'local'
    ? reapBoardMessages(clock)
    : reapHostedBoardCache(clock)
}
