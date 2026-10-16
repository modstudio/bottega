import type { Database } from 'bun:sqlite'
import { hostname } from 'node:os'
import type { BoardPurpose } from '../../../shared/board-purpose.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { classifyCaller } from '../caller-classification.ts'
import { db, nowIso, writableDb, writeTransaction } from '../database/db.ts'
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
import { missingReaderStartWarning, selectPushNotices } from './board-push-policy.ts'
import { renderBoardNotice, renderBoardNoticeOneLine } from './board-render.ts'
import {
  addressed,
  boardActor,
  boardOrigin,
  boardReaderBeganAt,
  type Environment,
  hasReceipt,
  insertRootMessage,
  type MessageRow,
  messageRows,
  messageTags,
  originText,
  type PostNoticeInput,
  type PostNoticeResult,
  recipients,
  rowIsLive,
} from './board-store.ts'
import { renderBoardQuestion, renderBoardReply } from './board-thread-render.ts'

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
      `SELECT launch_key FROM run
       WHERE session_id=? AND status IN ('running','asking') AND launch_key IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(identity.session) as { launch_key: string } | null
  writableDb()
    .query(
      `INSERT INTO presence
       (session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,?,'architect',?, ?,?, ?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET harness=excluded.harness, role=excluded.role,
         machine=excluded.machine, project=excluded.project,
         project_record_id=excluded.project_record_id, cwd=excluded.cwd,
         current_task_key=excluded.current_task_key, last_seen=excluded.last_seen`,
    )
    .run(
      identity.session,
      identity.harness,
      hostname(),
      project.name,
      project.recordId,
      cwd,
      current?.launch_key ?? null,
      at,
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

export function runReader(runId: number, database = db()): string {
  const row = database
    .query('SELECT COALESCE(parent_run_id,id) root_id FROM run WHERE id=?')
    .get(runId) as { root_id: number } | null
  if (!row) throw new Error(`no run ${runId}; use a live orchestrator run id`)
  return `run:${row.root_id}`
}

function wasDelivered(messageId: number, reader: string, database = db()): boolean {
  const receipt = database
    .query('SELECT delivered_at FROM board_receipt WHERE message_id=? AND reader_session=?')
    .get(messageId, reader) as { delivered_at: string | null } | null
  return Boolean(receipt?.delivered_at)
}

export function deliverableTo(
  message: MessageRow,
  reader: string,
  clock: number,
  database = db(),
): boolean {
  return message.kind === 'reply'
    ? hasReceipt(message.id, reader, database)
    : addressed(message, reader, clock, database)
}

function render(message: MessageRow, worker = false, database = db()) {
  const tags = messageTags(message.id, database)
  if (message.kind === 'reply') {
    const root = messageRows(database).find((candidate) => candidate.id === message.thread_root_id)
    if (!root?.title) throw new Error(`board reply ${message.id} has no thread root`)
    return {
      id: message.id,
      text: renderBoardReply({
        id: message.id,
        origin: originText(boardOrigin(message)),
        rootId: root.id,
        rootTitle: root.title,
        body: message.body,
      }),
      oneLine: renderBoardNoticeOneLine({
        id: message.id,
        title: root.title,
        sender: originText(boardOrigin(message)),
        ackRequired: false,
      }),
      purpose: 'information' as const,
    }
  }
  if (message.kind === 'question') {
    return {
      id: message.id,
      text: renderBoardQuestion({
        id: message.id,
        origin: originText(boardOrigin(message)),
        title: message.title ?? '',
        body: message.body,
        expiresAt: message.expires_at ?? '',
        tags: tags
          .filter((tag) => tag.origin === 'sender')
          .map((tag) => `${tag.kind}:${tag.value}`),
      }),
      oneLine: renderBoardNoticeOneLine({
        id: message.id,
        title: message.title ?? '',
        sender: originText(boardOrigin(message)),
        ackRequired: false,
      }),
      purpose: 'request' as const,
    }
  }
  return {
    id: message.id,
    text: renderBoardNotice({
      id: message.id,
      kind: message.kind,
      purpose: message.purpose ?? 'information',
      authorKind: message.author_kind,
      authorSession: message.author_session,
      authorHarness: message.author_harness,
      authorProject: message.author_project,
      authorRunId: message.author_run_id,
      title: message.title ?? '',
      body: message.body,
      expiresAt: message.expires_at ?? '',
      ackRequired: message.ack_required === 1,
      tags: tags.filter((tag) => tag.origin === 'sender'),
      worker,
    }),
    oneLine: renderBoardNoticeOneLine({
      id: message.id,
      title: message.title ?? '',
      sender: originText(boardOrigin(message)),
      ackRequired: message.ack_required === 1,
    }),
    purpose: message.purpose ?? 'information',
  }
}

export function claimRunNotices(
  runId: number,
  all = false,
  clock = Date.now(),
  database = db(),
): {
  id: number
  text: string
  oneLine: string
  ackRequired: boolean
  ackDeadline: string | null
  createdAt: string
  expiresAt: string | null
  purpose: BoardPurpose
}[] {
  const reader = runReader(runId, database)
  return messageRows(database)
    .filter(
      (row) =>
        row.kind === 'notice' &&
        rowIsLive(row, clock, database) &&
        addressed(row, reader, clock, database) &&
        (all || !wasDelivered(row.id, reader, database)),
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
  runId: number,
  all = false,
  clock = Date.now(),
  database = db(),
): {
  notices: ReturnType<typeof claimRunNotices>
  withheldOlderCount: number
  warning: string | null
} {
  const run = database
    .query('SELECT COALESCE(parent_run_id,id) root_id FROM run WHERE id=?')
    .get(runId) as { root_id: number } | null
  if (!run)
    return {
      ...selectPushNotices('unbounded', [], clock),
      warning: missingReaderStartWarning(`run:${runId}`),
    }
  const reader = `run:${run.root_id}`
  const beganAt = boardReaderBeganAt(reader, database)
  return {
    ...selectPushNotices(beganAt, claimRunNotices(runId, all, clock, database), clock),
    warning: beganAt === null ? missingReaderStartWarning(reader) : null,
  }
}

export function markRunNoticesDelivered(runId: number, ids: number[], clock = Date.now()): void {
  const reader = runReader(runId)
  const idSet = new Set(ids)
  const rows = messageRows().filter(
    (row) =>
      row.kind === 'notice' &&
      idSet.has(row.id) &&
      rowIsLive(row, clock) &&
      addressed(row, reader, clock),
  )
  if (!rows.length) return
  const database = writableDb()
  const deliveredAt = new Date(clock).toISOString()
  writeTransaction(() => {
    const stamp = database.query(
      `INSERT INTO board_receipt
       (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,record_id)
       VALUES (?,?,0,?,NULL,?) ON CONFLICT(message_id,reader_session) DO UPDATE SET
       delivered_at=COALESCE(board_receipt.delivered_at,excluded.delivered_at)`,
    )
    for (const row of rows) stamp.run(row.id, reader, deliveredAt, newRecordId())
  }, database)
}

export function claimNotices(
  all = false,
  env: Environment = process.env,
  clock = Date.now(),
  database = db(),
): {
  id: number
  text: string
  oneLine: string
  ackRequired: boolean
  ackDeadline: string | null
  createdAt: string
  expiresAt: string | null
  purpose: BoardPurpose
}[] {
  const reader = boardReader(env)
  const rows = messageRows(database).filter(
    (row) =>
      row.author_session !== reader &&
      rowIsLive(row, clock, database) &&
      deliverableTo(row, reader, clock, database) &&
      (all || !wasDelivered(row.id, reader, database)),
  )
  return rows.map((row) => ({
    ...render(row, false, database),
    ackRequired: row.ack_required === 1,
    ackDeadline: row.ack_deadline,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }))
}

export function claimPushNotices(
  all = false,
  env: Environment = process.env,
  clock = Date.now(),
  database = db(),
): {
  notices: ReturnType<typeof claimNotices>
  withheldOlderCount: number
  warning: string | null
} {
  const reader = boardReader(env)
  const beganAt =
    reader === OPERATOR_READER ? ('unbounded' as const) : boardReaderBeganAt(reader, database)
  const selected = selectPushNotices(beganAt, claimNotices(all, env, clock, database), clock)
  return {
    ...selected,
    warning:
      reader !== OPERATOR_READER && beganAt === null ? missingReaderStartWarning(reader) : null,
  }
}

export function markNoticesDelivered(
  ids: number[],
  env: Environment = process.env,
  clock = Date.now(),
  database: Database = writableDb(),
): void {
  const reader = boardReader(env)
  const idSet = new Set(ids)
  const rows = messageRows(database).filter(
    (row) =>
      idSet.has(row.id) &&
      row.author_session !== reader &&
      rowIsLive(row, clock, database) &&
      deliverableTo(row, reader, clock, database),
  )
  const deliveredAt = new Date(clock).toISOString()
  writeTransaction(() => {
    const stamp = database.query(
      `INSERT INTO board_receipt
       (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,record_id)
       VALUES (?,?,0,?,NULL,?) ON CONFLICT(message_id,reader_session) DO UPDATE SET
       delivered_at=COALESCE(board_receipt.delivered_at,excluded.delivered_at)`,
    )
    for (const row of rows) stamp.run(row.id, reader, deliveredAt, newRecordId())
  }, database)
}

export function readNotices(
  all = false,
  env: Environment = process.env,
  clock = Date.now(),
): {
  id: number
  text: string
  oneLine: string
  ackRequired: boolean
  createdAt: string
  purpose: BoardPurpose
}[] {
  const notices = claimNotices(all, env, clock)
  markNoticesDelivered(
    notices.map((notice) => notice.id),
    env,
    clock,
  )
  return notices
}

export function acknowledgeNotice(id: number, env: Environment = process.env, clock = Date.now()) {
  const reader = boardReader(env)
  const row = messageRows().find((candidate) => candidate.id === id)
  if (!row || !rowIsLive(row, clock) || !addressed(row, reader, clock))
    throw new Error(`live board notice ${id} is not addressed to this reader`)
  writableDb()
    .query(
      `INSERT INTO board_receipt
       (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,record_id)
       VALUES (?,?,0,?,?,?) ON CONFLICT(message_id,reader_session) DO UPDATE SET
       delivered_at=COALESCE(board_receipt.delivered_at,excluded.delivered_at),
       acknowledged_at=excluded.acknowledged_at`,
    )
    .run(id, reader, new Date(clock).toISOString(), new Date(clock).toISOString(), newRecordId())
}

export function noticeStatus(id: number, env: Environment = process.env, clock = Date.now()) {
  const actor = boardActor(env)
  const row = messageRows().find((candidate) => candidate.id === id)
  if (!row) throw new Error(`no board notice ${id}`)
  if (
    actor.kind !== 'operator' &&
    actor.session !== row.author_session &&
    !addressed(row, actor.session, clock)
  )
    throw new Error(`board notice ${id} was not authored by or addressed to this session`)
  const receipts = db()
    .query(
      `SELECT reader_session,audience_at_posting,delivered_at,acknowledged_at FROM board_receipt
       WHERE message_id=? ORDER BY reader_session`,
    )
    .all(id) as {
    reader_session: string
    audience_at_posting: number
    delivered_at: string | null
    acknowledged_at: string | null
  }[]
  const unresolved = new Set(
    row.ack_required && row.audience && parseAudience(row.audience).kind === 'machine'
      ? recipients(row.audience, clock, messageTags(row.id))
      : [],
  )
  for (const receipt of receipts) {
    if (receipt.reader_session.startsWith('run:')) continue
    if (receipt.acknowledged_at) unresolved.delete(receipt.reader_session)
    else unresolved.add(receipt.reader_session)
  }
  return {
    message: render(row),
    row,
    tags: messageTags(row.id),
    receipts,
    reached: receipts.length,
    acknowledged: receipts.filter((receipt) => receipt.acknowledged_at !== null).length,
    unacknowledged: row.ack_required
      ? [...unresolved].filter((reader) => !reader.startsWith('run:')).sort()
      : [],
  }
}

export function withdrawNotice(id: number, env: Environment = process.env, clock = Date.now()) {
  const actor = boardActor(env)
  const row = messageRows().find((candidate) => candidate.id === id)
  if (!row) throw new Error(`no board notice ${id}`)
  if (actor.kind !== 'operator' && actor.session !== row.author_session)
    throw new Error(`only the notice author or operator may withdraw board notice ${id}`)
  writableDb()
    .query('UPDATE board_message SET withdrawn_at=COALESCE(withdrawn_at,?) WHERE id=?')
    .run(new Date(clock).toISOString(), id)
}

export function markSessionMessagesDelivered(session: string, ids: number[], at = nowIso()) {
  requireRealSession(session, 'board delivery acknowledgement')
  const database = writableDb()
  for (const id of ids)
    database
      .query(
        `INSERT INTO board_receipt
         (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at,record_id)
         VALUES (?,?,0,?,NULL,?) ON CONFLICT(message_id,reader_session) DO UPDATE SET
         delivered_at=COALESCE(board_receipt.delivered_at,excluded.delivered_at)`,
      )
      .run(id, session, at, newRecordId())
}

export function boardEscalations(clock = Date.now()) {
  const rows = db()
    .query(
      `SELECT m.id,m.ack_required,m.ack_deadline,m.expires_at,m.withdrawn_at,r.reader_session,
              r.acknowledged_at,r.audience_at_posting
       FROM board_message m JOIN board_receipt r ON r.message_id=m.id
      `,
    )
    .all() as {
    id: number
    ack_required: number
    ack_deadline: string | null
    expires_at: string
    withdrawn_at: string | null
    reader_session: string
    acknowledged_at: string | null
    audience_at_posting: number
  }[]
  return rows
    .filter(
      (row) =>
        !row.reader_session.startsWith('run:') &&
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
      subject: `board:${row.id}:${row.reader_session}`,
      since: row.ack_deadline,
      ageMs: row.ack_deadline ? clock - Date.parse(row.ack_deadline) : null,
      detail: `Board notice ${row.id} is not acknowledged by ${row.reader_session}`,
      action: `inspect with ${PLATFORM_SLUG} board status ${row.id}`,
    }))
}

export function reapBoardMessages(clock = Date.now()): number {
  const rows = messageRows()
  const acceptedRoots = new Set(
    rows
      .filter((row) => row.kind === 'question' && row.accepted_reply_id !== null)
      .map((row) => row.id),
  )
  const ids = rows
    .filter(
      (row) =>
        !acceptedRoots.has(row.id) &&
        (row.thread_root_id === null || !acceptedRoots.has(row.thread_root_id)),
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
    .map((row) => row.id)
  const remove = writableDb().query('DELETE FROM board_message WHERE id=?')
  let reaped = 0
  for (const id of ids) reaped += remove.run(id).changes
  return reaped + reapHostedBoardCache(clock)
}
