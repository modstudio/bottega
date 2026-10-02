import { hostname } from 'node:os'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { db, nowIso, SESSION_LIVE_MS, writableDb, writeTransaction } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import {
  architectIdentity,
  audienceRefusal,
  BOARD_BODY_MAX_CHARS,
  BOARD_DEFAULT_ACK_DEADLINE_MS,
  BOARD_DEFAULT_EXPIRY_MS,
  BOARD_DUPLICATE_WINDOW_MS,
  BOARD_POST_RATE_WINDOW_MS,
  BOARD_TITLE_MAX_CHARS,
  messageCanBeReaped,
  messageIsLive,
  needsAckEscalation,
  OPERATOR_READER,
  parseAudience,
  postDecision,
  requireRealSession,
  resolveAudience,
  shouldInterrupt,
} from './board-policy.ts'
import { renderBoardNotice } from './board-render.ts'

type Environment = Record<string, string | undefined>
type Actor = { kind: 'operator'; session: null } | { kind: 'architect'; session: string }
type MessageRow = {
  id: number
  author_kind: string
  author_session: string | null
  audience: string
  title: string
  body: string
  ack_required: number
  ack_deadline: string | null
  expires_at: string
  created_at: string
  withdrawn_at: string | null
  author_harness: string | null
  author_project: string | null
}

const workerMarked = (env: Environment) => Boolean(env.ORCH_RUN_ID || env.ORCH_DEPTH)
const unrecognizedSessionMarked = (env: Environment) =>
  Object.entries(env).some(
    ([key, value]) => Boolean(value?.trim()) && /(?:SESSION_ID|THREAD_ID)$/.test(key),
  )

function boardActor(env: Environment = process.env): Actor {
  if (workerMarked(env))
    throw new Error('workers cannot use the architect notice board in this slice')
  if (env.CLAUDE_CODE_SESSION_ID?.trim() === OPERATOR_READER)
    throw new Error('operator is reserved and is not a session id')
  const identity = architectIdentity(env)
  if (identity) return { kind: 'architect', session: identity.session }
  if (unrecognizedSessionMarked(env))
    throw new Error(
      'this harness has no recognized architect identity; use a supported architect harness or post from an operator terminal',
    )
  return { kind: 'operator', session: null }
}

function boardReader(env: Environment = process.env): string {
  const actor = boardActor(env)
  return actor.session ?? OPERATOR_READER
}

export function recordPresence(
  cwd = process.cwd(),
  env: Environment = process.env,
  at = nowIso(),
): boolean {
  if (workerMarked(env)) return false
  if (env.CLAUDE_CODE_SESSION_ID?.trim() === OPERATOR_READER)
    throw new Error('operator is reserved and is not a session id')
  const identity = architectIdentity(env)
  if (!identity) return false
  if (identity.session === OPERATOR_READER)
    throw new Error('operator is reserved and is not a session id')
  const project = projectAt(cwd)
  if (!project) throw new Error(`no registered project contains ${cwd}; run orch project add first`)
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
       (session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
       VALUES (?,?,'architect',?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET harness=excluded.harness, role=excluded.role,
         machine=excluded.machine, project=excluded.project, cwd=excluded.cwd,
         current_task_key=excluded.current_task_key, last_seen=excluded.last_seen`,
    )
    .run(
      identity.session,
      identity.harness,
      hostname(),
      project.name,
      cwd,
      current?.launch_key ?? null,
      at,
    )
  return true
}

function presenceFacts() {
  return (
    db().query('SELECT session_id,project,machine,last_seen FROM presence').all() as {
      session_id: string
      project: string
      machine: string
      last_seen: string
    }[]
  ).map((row) => ({
    session: row.session_id,
    project: row.project,
    machine: row.machine,
    lastSeen: Date.parse(row.last_seen),
  }))
}

function recipients(audience: string, at: number): string[] {
  return resolveAudience(parseAudience(audience), presenceFacts(), at, SESSION_LIVE_MS)
}

export type PostNoticeInput = {
  audience: string
  title: string
  body: string
  ackRequired?: boolean
  deadlineMs?: number
  expiresMs?: number
}

export function postNotice(
  input: PostNoticeInput,
  env: Environment = process.env,
  clock = Date.now(),
  cwd = process.cwd(),
): { id: number; dropped: boolean } {
  if (input.title.length > BOARD_TITLE_MAX_CHARS)
    throw new Error(`board notice title exceeds ${BOARD_TITLE_MAX_CHARS} characters; shorten it`)
  if (input.body.length > BOARD_BODY_MAX_CHARS)
    throw new Error(`board notice body exceeds ${BOARD_BODY_MAX_CHARS} characters; shorten it`)
  if (containsSecretShaped(input.title) || containsSecretShaped(input.body))
    throw new Error('board notice contains secret-shaped text; remove the credential and retry')
  const actor = boardActor(env)
  const parsedAudience = parseAudience(input.audience)
  const postingMachine = hostname()
  const audience =
    parsedAudience.kind === 'machine' && parsedAudience.value === 'this'
      ? ({ kind: 'machine', value: postingMachine } as const)
      : parsedAudience
  const audienceExpression =
    audience.kind === 'machine' ? `machine:${audience.value}` : input.audience
  const refusal = audienceRefusal(audience, actor.kind)
  if (refusal) throw new Error(refusal)
  if (!input.title.trim() || !input.body.trim())
    throw new Error('board notice title and body are required')
  if (input.deadlineMs !== undefined && !input.ackRequired)
    throw new Error('a board notice deadline requires acknowledgement to be required')
  const deadlineMs = input.deadlineMs ?? BOARD_DEFAULT_ACK_DEADLINE_MS
  const expiresMs = input.expiresMs ?? BOARD_DEFAULT_EXPIRY_MS
  if (input.ackRequired && deadlineMs > expiresMs)
    throw new Error(
      `ack deadline ${deadlineMs}ms is later than expiry ${expiresMs}ms; set --deadline no later than --expires`,
    )
  const authorSession = actor.session
  let authorHarness: string | null = null
  let authorProject: string | null = null
  if (actor.kind === 'architect') {
    const postingProject = projectAt(cwd)
    if (!postingProject)
      throw new Error(
        `architect posting project is unknown for ${cwd}; post from a registered project or run orch project add first`,
      )
    authorHarness = architectIdentity(env)!.harness
    authorProject = postingProject.name
  }
  const since = new Date(clock - BOARD_POST_RATE_WINDOW_MS).toISOString()
  const duplicateSince = new Date(clock - BOARD_DUPLICATE_WINDOW_MS).toISOString()
  const recentPosts = (
    db()
      .query(
        `SELECT COUNT(*) n FROM board_message
         WHERE author_kind=? AND author_session IS ? AND created_at>=?`,
      )
      .get(actor.kind, authorSession, since) as { n: number }
  ).n
  const duplicate = db()
    .query(
      `SELECT id FROM board_message
       WHERE author_kind=? AND author_session IS ? AND audience=? AND title=? AND body=?
         AND created_at>=? ORDER BY id DESC LIMIT 1`,
    )
    .get(
      actor.kind,
      authorSession,
      audienceExpression,
      input.title,
      input.body,
      duplicateSince,
    ) as {
    id: number
  } | null
  const decision = postDecision({ recentPosts, duplicate: Boolean(duplicate) })
  if (decision === 'drop-duplicate') return { id: duplicate!.id, dropped: true }
  if (decision === 'rate-limited')
    throw new Error('board post rate limit reached; retry after the ten-minute author window')
  const createdAt = new Date(clock).toISOString()
  const ackRequired = input.ackRequired ?? false
  const deadline = ackRequired ? new Date(clock + deadlineMs).toISOString() : null
  const expiresAt = new Date(clock + expiresMs).toISOString()
  const database = writableDb()
  let id = 0
  writeTransaction(() => {
    if (actor.kind === 'architect') {
      const current = database
        .query(
          `SELECT launch_key FROM run
           WHERE session_id=? AND status IN ('running','asking') AND launch_key IS NOT NULL
           ORDER BY id DESC LIMIT 1`,
        )
        .get(actor.session) as { launch_key: string } | null
      database
        .query(
          `INSERT INTO presence
           (session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
           VALUES (?,?,'architect',?,?,?,?,?)
           ON CONFLICT(session_id) DO UPDATE SET harness=excluded.harness, role=excluded.role,
             machine=excluded.machine, project=excluded.project, cwd=excluded.cwd,
             current_task_key=excluded.current_task_key, last_seen=excluded.last_seen`,
        )
        .run(
          actor.session,
          authorHarness,
          postingMachine,
          authorProject,
          cwd,
          current?.launch_key ?? null,
          createdAt,
        )
    }
    const inserted = database
      .query(
        `INSERT INTO board_message
         (kind,author_kind,author_session,author_harness,author_project,audience,title,body,
          ack_required,ack_deadline,expires_at,created_at,withdrawn_at)
         VALUES ('notice',?,?,?,?,?,?,?,?,?,?,?,NULL)`,
      )
      .run(
        actor.kind,
        authorSession,
        authorHarness,
        authorProject,
        audienceExpression,
        input.title,
        input.body,
        ackRequired ? 1 : 0,
        deadline,
        expiresAt,
        createdAt,
      )
    id = Number(inserted.lastInsertRowid)
    const add = database.query(
      `INSERT OR IGNORE INTO board_receipt
       (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
       VALUES (?,?,1,NULL,NULL)`,
    )
    for (const reader of recipients(audienceExpression, clock)) add.run(id, reader)
  }, database)
  return { id, dropped: false }
}

function messageRows(): MessageRow[] {
  return db().query(`SELECT * FROM board_message ORDER BY id`).all() as MessageRow[]
}

function addressed(message: MessageRow, reader: string, clock: number): boolean {
  return recipients(message.audience, clock).includes(reader)
}

function rowIsLive(message: MessageRow, clock: number): boolean {
  return messageIsLive(
    {
      expiresAt: Date.parse(message.expires_at),
      withdrawnAt: message.withdrawn_at ? Date.parse(message.withdrawn_at) : null,
    },
    clock,
  )
}

function wasDelivered(messageId: number, reader: string): boolean {
  const receipt = db()
    .query('SELECT delivered_at FROM board_receipt WHERE message_id=? AND reader_session=?')
    .get(messageId, reader) as { delivered_at: string | null } | null
  return Boolean(receipt?.delivered_at)
}

function render(message: MessageRow) {
  return {
    id: message.id,
    text: renderBoardNotice({
      id: message.id,
      authorKind: message.author_kind,
      authorSession: message.author_session,
      authorHarness: message.author_harness,
      authorProject: message.author_project,
      title: message.title,
      body: message.body,
      expiresAt: message.expires_at,
      ackRequired: message.ack_required === 1,
    }),
  }
}

export function claimNotices(
  all = false,
  env: Environment = process.env,
  clock = Date.now(),
): { id: number; text: string }[] {
  const reader = boardReader(env)
  const rows = messageRows().filter(
    (row) =>
      rowIsLive(row, clock) &&
      addressed(row, reader, clock) &&
      (all || !wasDelivered(row.id, reader)),
  )
  return rows.map(render)
}

export function markNoticesDelivered(
  ids: number[],
  env: Environment = process.env,
  clock = Date.now(),
): void {
  const reader = boardReader(env)
  const idSet = new Set(ids)
  const rows = messageRows().filter(
    (row) => idSet.has(row.id) && rowIsLive(row, clock) && addressed(row, reader, clock),
  )
  const database = writableDb()
  const deliveredAt = new Date(clock).toISOString()
  writeTransaction(() => {
    const stamp = database.query(
      `INSERT INTO board_receipt
       (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
       VALUES (?,?,0,?,NULL) ON CONFLICT(message_id,reader_session) DO UPDATE SET
       delivered_at=COALESCE(board_receipt.delivered_at,excluded.delivered_at)`,
    )
    for (const row of rows) stamp.run(row.id, reader, deliveredAt)
  }, database)
}

export function readNotices(
  all = false,
  env: Environment = process.env,
  clock = Date.now(),
): { id: number; text: string }[] {
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
       (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
       VALUES (?,?,0,?,?) ON CONFLICT(message_id,reader_session) DO UPDATE SET
       delivered_at=COALESCE(board_receipt.delivered_at,excluded.delivered_at),
       acknowledged_at=excluded.acknowledged_at`,
    )
    .run(id, reader, new Date(clock).toISOString(), new Date(clock).toISOString())
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
    row.ack_required && parseAudience(row.audience).kind === 'machine'
      ? recipients(row.audience, clock)
      : [],
  )
  for (const receipt of receipts) {
    if (receipt.acknowledged_at) unresolved.delete(receipt.reader_session)
    else unresolved.add(receipt.reader_session)
  }
  return {
    message: render(row),
    receipts,
    unacknowledged: row.ack_required ? [...unresolved].sort() : [],
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

export function claimInterruptNotices(session: string, clock = Date.now()) {
  requireRealSession(session, 'board delivery')
  return messageRows()
    .filter(
      (row) =>
        rowIsLive(row, clock) &&
        addressed(row, session, clock) &&
        shouldInterrupt({
          authorKind: row.author_kind,
          audienceKind: parseAudience(row.audience).kind,
          ackRequired: row.ack_required === 1,
        }) &&
        !wasDelivered(row.id, session),
    )
    .map((row) => ({ noticeId: `board:${row.id}` as const, detail: render(row).text }))
}

export function markInterruptNoticesDelivered(session: string, ids: number[], at = nowIso()) {
  requireRealSession(session, 'board delivery acknowledgement')
  const database = writableDb()
  for (const id of ids)
    database
      .query(
        `INSERT INTO board_receipt
         (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
         VALUES (?,?,0,?,NULL) ON CONFLICT(message_id,reader_session) DO UPDATE SET
         delivered_at=COALESCE(board_receipt.delivered_at,excluded.delivered_at)`,
      )
      .run(id, session, at)
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
    .filter((row) =>
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
      action: `inspect with orch board status ${row.id}`,
    }))
}

export function reapBoardMessages(clock = Date.now()): number {
  const ids = messageRows()
    .filter((row) =>
      messageCanBeReaped(
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
  return reaped
}
