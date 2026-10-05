import { hostname } from 'node:os'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { db, nowIso, SESSION_LIVE_MS, writableDb, writeTransaction } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import { boardContext, boardRunContext } from './board-context.ts'
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
import { boardNoticeMatches } from './board-routing.ts'
import {
  type BoardTag,
  inferredBoardTags,
  type SenderBoardTags,
  senderBoardTags,
  senderTagKey,
} from './board-tags.ts'

export { requireRealSession } from './board-policy.ts'

type Environment = Record<string, string | undefined>
type Actor = { kind: 'operator'; session: null } | { kind: 'architect'; session: string }
type PostNoticeResult = { id: number; dropped: boolean; reached: number; warning?: string }
type MessageRow = {
  id: number
  kind: string
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
  author_run_id: number | null
}

const NO_REACH_WARNING = 'reached no live session; re-address it or wait for a matching session'

const workerMarked = (env: Environment) => Boolean(env.ORCH_RUN_ID || env.ORCH_DEPTH)
const unrecognizedSessionMarked = (env: Environment) =>
  Object.entries(env).some(
    ([key, value]) => Boolean(value?.trim()) && /(?:SESSION_ID|THREAD_ID)$/.test(key),
  )

export function boardActor(env: Environment = process.env): Actor {
  if (workerMarked(env))
    throw new Error('workers cannot use the architect notice board in this slice')
  if (
    env.CLAUDE_CODE_SESSION_ID?.trim() === OPERATOR_READER ||
    env.CLAUDE_CODE_SESSION_ID?.trim().startsWith('run:')
  )
    throw new Error(
      'operator and run:<id> readers are reserved; use a real architect session id or address the worker with run:<id>',
    )
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

function presenceFacts(database = db()) {
  const architects = (
    database.query('SELECT session_id,project,machine,last_seen FROM presence').all() as {
      session_id: string
      project: string
      machine: string
      last_seen: string
    }[]
  ).map((row) => ({
    reader: row.session_id,
    role: 'architect' as const,
    project: row.project,
    machine: row.machine,
    lastSeen: Date.parse(row.last_seen),
  }))
  const liveTurns = database
    .query(
      `SELECT id,COALESCE(parent_run_id,id) root_id,repo,status,turn
       FROM run WHERE repo IS NOT NULL
       ORDER BY root_id,turn DESC`,
    )
    .all() as { id: number; root_id: number; repo: string; status: string; turn: number }[]
  const workers = new Map<number, (typeof liveTurns)[number] & { runIds: Set<number> }>()
  for (const row of liveTurns) {
    const current = workers.get(row.root_id)
    if (!current) workers.set(row.root_id, { ...row, runIds: new Set([row.id, row.root_id]) })
    else current.runIds.add(row.id)
  }
  return [
    ...architects,
    ...[...workers.values()]
      .filter((row) => row.status === 'running' || row.status === 'asking')
      .map((row) => ({
        reader: `run:${row.root_id}`,
        role: 'worker' as const,
        project: row.repo,
        machine: hostname(),
        live: true,
        runIds: row.runIds,
      })),
  ]
}

function recipients(
  audienceExpression: string,
  at: number,
  tags: BoardTag[],
  database = db(),
): string[] {
  const audience = parseAudience(audienceExpression)
  const coarse = resolveAudience(audience, presenceFacts(database), at, SESSION_LIVE_MS)
  if (audience.kind !== 'project' && audience.kind !== 'workers') return coarse
  return coarse.filter((reader) => {
    const run = /^run:(\d+)$/.exec(reader)
    return boardNoticeMatches(
      tags,
      run ? boardRunContext(Number(run[1]), database) : boardContext(reader, at, database),
    )
  })
}

export type PostNoticeInput = SenderBoardTags & {
  audience: string
  title: string
  body: string
  ackRequired?: boolean
  deadlineMs?: number
  expiresMs?: number
  suggestingRunId?: number
}

function resolvePostAudience(expression: string, machine: string) {
  const audience = parseAudience(expression)
  if (audience.kind !== 'machine') return { audience, expression }
  const value = audience.value === 'this' ? machine : audience.value
  return { audience: { kind: 'machine' as const, value }, expression: `machine:${value}` }
}

function resolvePostOrigin(actor: Actor, env: Environment, cwd: string) {
  if (actor.kind === 'operator') return { harness: null, project: null }
  const project = projectAt(cwd)
  if (!project)
    throw new Error(
      `architect posting project is unknown for ${cwd}; post from a registered project or run orch project add first`,
    )
  return { harness: architectIdentity(env)!.harness, project: project.name }
}

function postNoticeResult(id: number, dropped: boolean, reached: number): PostNoticeResult {
  return {
    id,
    dropped,
    reached,
    ...(reached === 0 ? { warning: NO_REACH_WARNING } : {}),
  }
}

function refreshPostingPresence(
  database: ReturnType<typeof writableDb>,
  actor: Actor,
  origin: ReturnType<typeof resolvePostOrigin>,
  machine: string,
  cwd: string,
  at: string,
): void {
  if (actor.kind !== 'architect') return
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
      origin.harness,
      machine,
      origin.project,
      cwd,
      current?.launch_key ?? null,
      at,
    )
}

export function postNotice(
  input: PostNoticeInput,
  env: Environment = process.env,
  clock = Date.now(),
  cwd = process.cwd(),
): PostNoticeResult {
  if (input.title.length > BOARD_TITLE_MAX_CHARS)
    throw new Error(`board notice title exceeds ${BOARD_TITLE_MAX_CHARS} characters; shorten it`)
  if (input.body.length > BOARD_BODY_MAX_CHARS)
    throw new Error(`board notice body exceeds ${BOARD_BODY_MAX_CHARS} characters; shorten it`)
  if (containsSecretShaped(input.title) || containsSecretShaped(input.body))
    throw new Error('board notice contains secret-shaped text; remove the credential and retry')
  if (
    [input.task, ...(input.paths ?? []), ...(input.topics ?? [])].some(
      (value) => value !== undefined && containsSecretShaped(value),
    )
  )
    throw new Error('board notice tag contains secret-shaped text; remove the credential and retry')
  const actor = boardActor(env)
  const postingMachine = hostname()
  const { audience, expression: audienceExpression } = resolvePostAudience(
    input.audience,
    postingMachine,
  )
  const refusal = audienceRefusal(audience, actor.kind)
  if (refusal) throw new Error(refusal)
  if (!input.title.trim() || !input.body.trim())
    throw new Error('board notice title and body are required')
  if (input.deadlineMs !== undefined && !input.ackRequired)
    throw new Error('a board notice deadline requires acknowledgement to be required')
  const senderTags = senderBoardTags(input)
  const deadlineMs = input.deadlineMs ?? BOARD_DEFAULT_ACK_DEADLINE_MS
  const expiresMs = input.expiresMs ?? BOARD_DEFAULT_EXPIRY_MS
  if (input.ackRequired && deadlineMs > expiresMs)
    throw new Error(
      `ack deadline ${deadlineMs}ms is later than expiry ${expiresMs}ms; set --deadline no later than --expires`,
    )
  const authorSession = actor.session
  const origin = resolvePostOrigin(actor, env, cwd)
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
  const duplicateCandidates = db()
    .query(
      `SELECT id FROM board_message
       WHERE author_kind=? AND author_session IS ? AND author_run_id IS ?
         AND audience=? AND title=? AND body=?
         AND created_at>=? ORDER BY id DESC`,
    )
    .all(
      actor.kind,
      authorSession,
      input.suggestingRunId ?? null,
      audienceExpression,
      input.title,
      input.body,
      duplicateSince,
    ) as { id: number }[]
  const senderTagsKey = senderTagKey(senderTags)
  const duplicate = duplicateCandidates.find((candidate) => {
    const storedTags = db()
      .query(
        `SELECT kind,value FROM board_message_tag
         WHERE message_id=? AND origin='sender'`,
      )
      .all(candidate.id) as Pick<BoardTag, 'kind' | 'value'>[]
    return senderTagKey(storedTags) === senderTagsKey
  })
  const decision = postDecision({ recentPosts, duplicate: Boolean(duplicate) })
  if (decision === 'drop-duplicate') {
    const reached = (
      db()
        .query(
          'SELECT COUNT(*) count FROM board_receipt WHERE message_id=? AND audience_at_posting=1',
        )
        .get(duplicate!.id) as { count: number }
    ).count
    return postNoticeResult(duplicate!.id, true, reached)
  }
  if (decision === 'rate-limited')
    throw new Error('board post rate limit reached; retry after the ten-minute author window')
  const createdAt = new Date(clock).toISOString()
  const ackRequired = input.ackRequired ?? false
  const deadline = ackRequired ? new Date(clock + deadlineMs).toISOString() : null
  const expiresAt = new Date(clock + expiresMs).toISOString()
  const database = writableDb()
  let id = 0
  let reached = 0
  writeTransaction(() => {
    refreshPostingPresence(database, actor, origin, postingMachine, cwd, createdAt)
    const currentTaskKey = actor.session
      ? ((
          database
            .query('SELECT current_task_key FROM presence WHERE session_id=?')
            .get(actor.session) as { current_task_key: string | null } | null
        )?.current_task_key ?? null)
      : null
    const tags = [...senderTags, ...inferredBoardTags(input.body, senderTags, currentTaskKey)]
    const inserted = database
      .query(
        `INSERT INTO board_message
         (kind,author_kind,author_session,author_run_id,author_harness,author_project,audience,title,body,
          ack_required,ack_deadline,expires_at,created_at,withdrawn_at)
         VALUES ('notice',?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
      )
      .run(
        actor.kind,
        authorSession,
        input.suggestingRunId ?? null,
        origin.harness,
        origin.project,
        audienceExpression,
        input.title,
        input.body,
        ackRequired ? 1 : 0,
        deadline,
        expiresAt,
        createdAt,
      )
    id = Number(inserted.lastInsertRowid)
    const addTag = database.query(
      `INSERT OR IGNORE INTO board_message_tag (message_id,kind,value,origin)
       VALUES (?,?,?,?)`,
    )
    for (const tag of tags) addTag.run(id, tag.kind, tag.value, tag.origin)
    const add = database.query(
      `INSERT OR IGNORE INTO board_receipt
       (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
       VALUES (?,?,1,NULL,NULL)`,
    )
    const postingRecipients = recipients(audienceExpression, clock, tags, database)
    reached = postingRecipients.length
    for (const reader of postingRecipients) add.run(id, reader)
  }, database)
  return postNoticeResult(id, false, reached)
}

function messageRows(): MessageRow[] {
  return db().query(`SELECT * FROM board_message ORDER BY id`).all() as MessageRow[]
}

function messageTags(messageId: number): BoardTag[] {
  return db()
    .query('SELECT kind,value,origin FROM board_message_tag WHERE message_id=? ORDER BY rowid')
    .all(messageId) as BoardTag[]
}

function addressed(message: MessageRow, reader: string, clock: number): boolean {
  return recipients(message.audience, clock, messageTags(message.id)).includes(reader)
}

function runReader(runId: number): string {
  const row = db()
    .query('SELECT COALESCE(parent_run_id,id) root_id FROM run WHERE id=?')
    .get(runId) as { root_id: number } | null
  if (!row) throw new Error(`no run ${runId}; use a live orchestrator run id`)
  return `run:${row.root_id}`
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

function render(message: MessageRow, worker = false) {
  const tags = messageTags(message.id)
  return {
    id: message.id,
    text: renderBoardNotice({
      id: message.id,
      kind: message.kind,
      authorKind: message.author_kind,
      authorSession: message.author_session,
      authorHarness: message.author_harness,
      authorProject: message.author_project,
      authorRunId: message.author_run_id,
      title: message.title,
      body: message.body,
      expiresAt: message.expires_at,
      ackRequired: message.ack_required === 1,
      tags: tags.filter((tag) => tag.origin === 'sender'),
      worker,
    }),
  }
}

export function claimRunNotices(
  runId: number,
  all = false,
  clock = Date.now(),
): { id: number; text: string; ackRequired: boolean; createdAt: string }[] {
  const reader = runReader(runId)
  return messageRows()
    .filter(
      (row) =>
        row.kind === 'notice' &&
        rowIsLive(row, clock) &&
        addressed(row, reader, clock) &&
        (all || !wasDelivered(row.id, reader)),
    )
    .map((row) => ({
      ...render(row, true),
      ackRequired: row.ack_required === 1,
      createdAt: row.created_at,
    }))
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
       (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
       VALUES (?,?,0,?,NULL) ON CONFLICT(message_id,reader_session) DO UPDATE SET
       delivered_at=COALESCE(board_receipt.delivered_at,excluded.delivered_at)`,
    )
    for (const row of rows) stamp.run(row.id, reader, deliveredAt)
  }, database)
}

export function readRunNotices(runId: number, all = false, clock = Date.now()) {
  const notices = claimRunNotices(runId, all, clock)
  markRunNoticesDelivered(
    runId,
    notices.map((notice) => notice.id),
    clock,
  )
  return notices
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
  return rows.map((row) => render(row))
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

export function claimInterruptNotices(session: string, clock = Date.now()) {
  requireRealSession(session, 'board delivery')
  return messageRows()
    .filter(
      (row) =>
        row.kind === 'notice' &&
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
