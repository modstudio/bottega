import type { Database } from 'bun:sqlite'
import { hostname } from 'node:os'
import type { BoardPurpose } from '../../../shared/board-purpose.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { classifyCaller } from '../caller-classification.ts'
import { db, nowIso, SESSION_LIVE_MS, writableDb, writeTransaction } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import { reapHostedBoardCache } from './board-hosted-cache.ts'
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
  replySuccessorAddressing,
  selectPushNotices,
} from './board-push-policy.ts'
import { renderBoardNotice, renderBoardNoticeOneLine } from './board-render.ts'
import {
  addressed,
  boardActor,
  boardOrigin,
  boardReaderBeganAt,
  type Environment,
  hasNonSuccessorReceipt,
  hasReceipt,
  insertRootMessage,
  type MessageRow,
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

function boardReader(env: Environment = process.env): string {
  const actor = boardActor(env)
  return actor.session ?? OPERATOR_READER
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
  return true
}

export function postNotice(
  input: PostNoticeInput,
  env: Environment = process.env,
  clock = Date.now(),
  cwd = process.cwd(),
): PostNoticeResult {
  const database = writableDb()
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

export function runReaderIdentity(runId: string, database = db()) {
  const row = database
    .query('SELECT COALESCE(parent_run_record_id,record_id) root_id FROM run WHERE record_id=?')
    .get(runId) as { root_id: string } | null
  if (!row) throw new Error(`no run ${runId}; use a live orchestrator run id`)
  return { reader: `run:${row.root_id}`, readerRunRecordId: row.root_id }
}

function receiptDelivery(messageRecordId: string, reader: string, database = db()) {
  return database
    .query('SELECT delivered_at FROM board_receipt WHERE message_record_id=? AND reader_session=?')
    .get(messageRecordId, reader) as { delivered_at: string | null } | null
}

function wasDelivered(messageRecordId: string, reader: string, database = db()): boolean {
  return Boolean(receiptDelivery(messageRecordId, reader, database)?.delivered_at)
}

function replySuccessorPush(
  reply: MessageRow,
  reader: string,
  clock: number,
  database: Database,
): boolean {
  if (reply.kind !== 'reply' || reply.thread_root_record_id === null) return false
  const root = messageRows(database).find(
    (candidate) => candidate.record_id === reply.thread_root_record_id,
  )
  if (!root?.author_session || !root.author_project) return false
  return replySuccessorAddressing({
    presence: presenceFacts(database, clock),
    reader,
    rootAuthorSession: root.author_session,
    rootAuthorReceivedReply: wasDelivered(reply.record_id, root.author_session, database),
    rootProject: root.author_project,
    readerIsParticipant: hasNonSuccessorReceipt(reply.record_id, reader, database),
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
): boolean {
  return message.kind === 'reply'
    ? hasReceipt(message.record_id, reader, database) ||
        replySuccessorPush(message, reader, clock, database)
    : addressed(message, reader, clock, database)
}

function render(message: MessageRow, worker = false, database = db()) {
  const tags = messageTags(message.record_id, database)
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
  const run = database
    .query('SELECT COALESCE(parent_run_record_id,record_id) root_id FROM run WHERE record_id=?')
    .get(runId) as { root_id: string } | null
  if (!run) {
    const selected = selectPushNotices('unbounded', [], clock)
    return {
      notices: selected.notices,
      withheldOlderCount: selected.withheldOlderCount,
      warning: missingReaderStartWarning(`run:${runId}`),
    }
  }
  const reader = `run:${run.root_id}`
  const beganAt = boardReaderBeganAt(reader, database, run.root_id)
  const selected = selectPushNotices(beganAt, claimRunNotices(runId, all, clock, database), clock)
  return {
    notices: selected.notices,
    withheldOlderCount: selected.withheldOlderCount,
    warning: beganAt === null ? missingReaderStartWarning(reader) : null,
  }
}

export function markRunNoticesDelivered(runId: string, ids: string[], clock = Date.now()): void {
  const { reader, readerRunRecordId } = runReaderIdentity(runId)
  const idSet = new Set(ids)
  const rows = messageRows().filter(
    (row) =>
      row.kind === 'notice' &&
      idSet.has(row.record_id) &&
      rowIsLive(row, clock) &&
      addressed(row, reader, clock),
  )
  if (!rows.length) return
  const database = writableDb()
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
  reportReplySuccessor?: boolean
  threadTitle?: string
}[] {
  const reader = boardReader(env)
  const rows = messageRows(database).filter(
    (row) =>
      row.author_session !== reader &&
      rowIsLive(row, clock, database) &&
      deliverableTo(row, reader, clock, database) &&
      (all || !wasDelivered(row.record_id, reader, database)),
  )
  return rows.map((row) => {
    const notice = {
      ...render(row, false, database),
      ackRequired: row.ack_required === 1,
      ackDeadline: row.ack_deadline,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
    return row.kind === 'reply' && replySuccessorPush(row, reader, clock, database)
      ? { ...notice, reportReplySuccessor: true }
      : notice
  })
}

export function claimPushNotices(
  all = false,
  env: Environment = process.env,
  clock = Date.now(),
  database: Database = writableDb(),
  claimReplySuccessors = true,
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
    claimNotices(all, env, clock, database),
    clock,
    claimReplySuccessors,
  )
  const notices = selected.notices.filter((notice) => {
    if (!notice.reportReplySuccessor) return true
    const row = messageRows(database).find((item) => item.record_id === notice.recordId)
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
): void {
  const reader = boardReader(env)
  const idSet = new Set(ids)
  const rows = messageRows(database).filter(
    (row) =>
      idSet.has(row.record_id) &&
      row.author_session !== reader &&
      rowIsLive(row, clock, database) &&
      deliverableTo(row, reader, clock, database),
  )
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

export function acknowledgeNotice(id: string, env: Environment = process.env, clock = Date.now()) {
  const reader = boardReader(env)
  const row = messageRows().find((candidate) => candidate.record_id === id)
  if (!row || !rowIsLive(row, clock) || !addressed(row, reader, clock))
    throw new Error(`live board notice ${id} is not addressed to this reader`)
  writableDb()
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

export function noticeStatus(id: string, env: Environment = process.env, clock = Date.now()) {
  const actor = boardActor(env)
  const row = messageRows().find((candidate) => candidate.record_id === id)
  if (!row) throw new Error(`no board notice ${id}`)
  if (
    actor.kind !== 'operator' &&
    actor.session !== row.author_session &&
    !addressed(row, actor.session, clock)
  )
    throw new Error(`board notice ${id} was not authored by or addressed to this session`)
  const receipts = db()
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
      ? recipients(row.audience, clock, messageTags(row.record_id))
      : [],
  )
  for (const receipt of receipts) {
    if (receipt.reader_run_record_id !== null) continue
    if (receipt.acknowledged_at) unresolved.delete(receipt.reader_session)
    else unresolved.add(receipt.reader_session)
  }
  return {
    message: render(row),
    row,
    tags: messageTags(row.record_id),
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

export function withdrawNotice(id: string, env: Environment = process.env, clock = Date.now()) {
  const actor = boardActor(env)
  const row = messageRows().find((candidate) => candidate.record_id === id)
  if (!row) throw new Error(`no board notice ${id}`)
  if (actor.kind !== 'operator' && actor.session !== row.author_session)
    throw new Error(`only the notice author or operator may withdraw board notice ${id}`)
  writableDb()
    .query(
      "UPDATE board_message SET withdrawn_reason=CASE WHEN withdrawn_at IS NULL THEN 'author' ELSE withdrawn_reason END,withdrawn_at=COALESCE(withdrawn_at,?) WHERE record_id=?",
    )
    .run(new Date(clock).toISOString(), row.record_id)
}

export function markSessionMessagesDelivered(session: string, ids: string[], at = nowIso()) {
  requireRealSession(session, 'board delivery acknowledgement')
  const database = writableDb()
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

export function boardEscalations(clock = Date.now()) {
  const rows = db()
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
  return rows
    .filter(
      (row) =>
        row.reader_run_record_id === null &&
        needsAckEscalation({
          ackRequired: row.ack_required === 1,
          deadline: row.ack_deadline ? Date.parse(row.ack_deadline) : null,
          expiresAt: Date.parse(row.expires_at),
          withdrawnAt: row.withdrawn_at ? Date.parse(row.withdrawn_at) : null,
          acknowledgedAt: row.acknowledged_at ? Date.parse(row.acknowledged_at) : null,
          audienceAtPosting: row.audience_at_posting === 1,
          now: clock,
        }),
    )
    .map((row) => ({
      kind: 'board-ack-overdue',
      subject: `board:${row.number}:${row.reader_session}`,
      since: row.ack_deadline,
      ageMs: row.ack_deadline ? clock - Date.parse(row.ack_deadline) : null,
      detail: `Board notice ${row.number} is not acknowledged by ${row.reader_session}`,
      action: `inspect with ${PLATFORM_SLUG} board status ${row.number}`,
    }))
}

export function reapBoardMessages(clock = Date.now()): number {
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
