import { hostname } from 'node:os'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { db, SESSION_LIVE_MS, type writableDb } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import { claimIsLive } from './board-claim-policy.ts'
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
  messageIsLive,
  OPERATOR_READER,
  parseAudience,
  postDecision,
  resolveAudience,
  runAudienceRefusal,
} from './board-policy.ts'
import { boardNoticeMatches } from './board-routing.ts'
import {
  type BoardTag,
  inferredBoardTags,
  type SenderBoardTags,
  senderBoardTags,
  senderTagKey,
} from './board-tags.ts'

export type Environment = Record<string, string | undefined>
export type BoardActor =
  | { kind: 'operator'; session: null }
  | { kind: 'architect'; session: string }
export type PostNoticeResult = { id: number; dropped: boolean; reached: number; warning?: string }
export type PostNoticeInput = SenderBoardTags & {
  audience: string
  title: string
  body: string
  ackRequired?: boolean
  deadlineMs?: number
  expiresMs?: number
  suggestingRunId?: number
}
export type MessageRow = {
  id: number
  kind: string
  author_kind: string
  author_session: string | null
  audience: string | null
  title: string | null
  body: string
  ack_required: number
  ack_deadline: string | null
  expires_at: string | null
  created_at: string
  withdrawn_at: string | null
  author_harness: string | null
  author_project: string | null
  author_run_id: number | null
  thread_root_id: number | null
  accepted_reply_id: number | null
  accepted_by: string | null
  accepted_at: string | null
  note_id: number | null
  note_pending_error: string | null
  note_filing_started_at: string | null
  claim_id: number | null
}

const NO_REACH_WARNING = 'reached no live session; re-address it or wait for a matching session'

const workerMarked = (env: Environment) => Boolean(env.ORCH_RUN_ID || env.ORCH_DEPTH)
const unrecognizedSessionMarked = (env: Environment) =>
  Object.entries(env).some(
    ([key, value]) => Boolean(value?.trim()) && /(?:SESSION_ID|THREAD_ID)$/.test(key),
  )

export function boardActor(env: Environment = process.env): BoardActor {
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

function presenceFacts(database = db(), at = Date.now()) {
  const architects = (
    database
      .query('SELECT session_id,project,machine,last_seen,current_task_key FROM presence')
      .all() as {
      session_id: string
      project: string
      machine: string
      last_seen: string
      current_task_key: string | null
    }[]
  ).map((row) => ({
    reader: row.session_id,
    role: 'architect' as const,
    project: row.project,
    machine: row.machine,
    lastSeen: Date.parse(row.last_seen),
    taskKeys: new Set(row.current_task_key ? [row.current_task_key] : []),
  }))
  const liveTurns = database
    .query(
      `WITH ranked AS (
         SELECT id,COALESCE(parent_run_id,id) root_id,status,
                ROW_NUMBER() OVER (
                  PARTITION BY COALESCE(parent_run_id,id) ORDER BY turn DESC,id DESC
                ) rank
         FROM run
       ), live_roots AS (
         SELECT root_id FROM ranked WHERE rank=1 AND status IN ('running','asking')
       )
       SELECT run.id,COALESCE(run.parent_run_id,run.id) root_id,run.repo,run.status,run.turn,
              root.launch_key
       FROM run JOIN live_roots ON live_roots.root_id=COALESCE(run.parent_run_id,run.id)
       JOIN run root ON root.id=COALESCE(run.parent_run_id,run.id)
       ORDER BY root_id,run.turn DESC`,
    )
    .all() as {
    id: number
    root_id: number
    repo: string | null
    status: string
    turn: number
    launch_key: string | null
  }[]
  const workers = new Map<number, (typeof liveTurns)[number] & { runIds: Set<number> }>()
  for (const row of liveTurns) {
    const current = workers.get(row.root_id)
    if (!current) workers.set(row.root_id, { ...row, runIds: new Set([row.id, row.root_id]) })
    else current.runIds.add(row.id)
  }
  const claims = database
    .query(
      `SELECT claim.holder_kind,claim.holder_session,claim.subject_value,claim.lapses_at,
              latest.status run_status
       FROM board_claim claim
       LEFT JOIN run member ON member.id=claim.run_id
       LEFT JOIN run latest ON latest.id=(
         SELECT id FROM run
         WHERE id=COALESCE(member.parent_run_id,member.id)
            OR parent_run_id=COALESCE(member.parent_run_id,member.id)
         ORDER BY turn DESC,id DESC LIMIT 1)
       WHERE claim.closed_at IS NULL AND claim.subject_kind='task'`,
    )
    .all() as {
    holder_kind: 'operator' | 'architect'
    holder_session: string | null
    subject_value: string
    lapses_at: string
    run_status: string | null
  }[]
  const claimReaders = new Map<string, { role: 'operator' | 'architect'; taskKeys: Set<string> }>()
  for (const claim of claims) {
    if (
      !claimIsLive({
        closed: false,
        lapsesAt: Date.parse(claim.lapses_at),
        runStatus: claim.run_status,
        now: at,
      })
    )
      continue
    const reader = claim.holder_kind === 'operator' ? OPERATOR_READER : claim.holder_session!
    const fact = claimReaders.get(reader) ?? {
      role: claim.holder_kind,
      taskKeys: new Set<string>(),
    }
    fact.taskKeys.add(claim.subject_value)
    claimReaders.set(reader, fact)
  }
  return [
    ...architects,
    ...[...workers.values()].map((row) => ({
      reader: `run:${row.root_id}`,
      role: 'worker' as const,
      project: row.repo ?? '',
      machine: hostname(),
      live: true,
      runIds: row.runIds,
      taskKeys: new Set(row.launch_key ? [row.launch_key] : []),
    })),
    ...[...claimReaders].map(([reader, fact]) => ({
      reader,
      role: fact.role,
      project: '',
      machine: hostname(),
      live: true,
      taskKeys: fact.taskKeys,
      taskAudienceOnly: true,
    })),
  ]
}

export function recipients(
  audienceExpression: string,
  at: number,
  tags: BoardTag[],
  database = db(),
): string[] {
  const audience = parseAudience(audienceExpression)
  const coarse = resolveAudience(audience, presenceFacts(database, at), at, SESSION_LIVE_MS)
  if (audience.kind !== 'project' && audience.kind !== 'workers') return coarse
  return coarse.filter((reader) => {
    const run = /^run:(\d+)$/.exec(reader)
    return boardNoticeMatches(
      tags,
      run ? boardRunContext(Number(run[1]), database) : boardContext(reader, at, database),
    )
  })
}

function resolvePostAudience(expression: string, machine: string) {
  const audience = parseAudience(expression)
  if (audience.kind !== 'machine') return { audience, expression }
  const value = audience.value === 'this' ? machine : audience.value
  return { audience: { kind: 'machine' as const, value }, expression: `machine:${value}` }
}

function resolvePostOrigin(actor: BoardActor, env: Environment, cwd: string) {
  if (actor.kind === 'operator') return { harness: null, project: null }
  const project = projectAt(cwd)
  if (!project)
    throw new Error(
      `architect posting project is unknown for ${cwd}; post from a registered project or run orch project add first`,
    )
  return { harness: architectIdentity(env)!.harness, project: project.name }
}

function runOwnerSession(runId: number, database: ReturnType<typeof writableDb>): string | null {
  const row = database
    .query(
      `SELECT root.session_id
       FROM run turn JOIN run root ON root.id=COALESCE(turn.parent_run_id,turn.id)
       WHERE turn.id=?`,
    )
    .get(runId) as { session_id: string | null } | null
  return row?.session_id ?? null
}

function validatePostNoticeInput(input: PostNoticeInput): void {
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
  if (!input.title.trim() || !input.body.trim())
    throw new Error('board notice title and body are required')
  if (input.deadlineMs !== undefined && !input.ackRequired)
    throw new Error('a board notice deadline requires acknowledgement to be required')
}

function postNoticeResult(id: number, dropped: boolean, reached: number): PostNoticeResult {
  return { id, dropped, reached, ...(reached === 0 ? { warning: NO_REACH_WARNING } : {}) }
}

function refreshPostingPresence(
  database: ReturnType<typeof writableDb>,
  actor: BoardActor,
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

export function authorWindowDecision(
  actor: BoardActor,
  clock: number,
  duplicate: boolean,
  database: ReturnType<typeof writableDb>,
) {
  const since = new Date(clock - BOARD_POST_RATE_WINDOW_MS).toISOString()
  const recentPosts = (
    database
      .query(
        `SELECT COUNT(*) n FROM board_message
         WHERE author_kind=? AND author_session IS ? AND created_at>=?`,
      )
      .get(actor.kind, actor.session, since) as { n: number }
  ).n
  return postDecision({ recentPosts, duplicate })
}

export function insertRootMessage(
  kind: 'notice' | 'question',
  input: PostNoticeInput,
  env: Environment,
  clock: number,
  cwd: string,
  database: ReturnType<typeof writableDb>,
): PostNoticeResult {
  validatePostNoticeInput(input)
  const actor = boardActor(env)
  const postingMachine = hostname()
  const { audience, expression: audienceExpression } = resolvePostAudience(
    input.audience,
    postingMachine,
  )
  const refusal = audienceRefusal(audience, actor.kind)
  if (refusal) throw new Error(refusal)
  const runRefusal = runAudienceRefusal(
    audience,
    actor.kind,
    actor.session,
    audience.kind === 'run' ? runOwnerSession(audience.value, database) : null,
  )
  if (runRefusal) throw new Error(runRefusal)
  const senderTags = senderBoardTags(input)
  const deadlineMs = input.deadlineMs ?? BOARD_DEFAULT_ACK_DEADLINE_MS
  const expiresMs = input.expiresMs ?? BOARD_DEFAULT_EXPIRY_MS
  if (input.ackRequired && deadlineMs > expiresMs)
    throw new Error(
      `ack deadline ${deadlineMs}ms is later than expiry ${expiresMs}ms; set --deadline no later than --expires`,
    )
  const origin = resolvePostOrigin(actor, env, cwd)
  const duplicateCandidates = database
    .query(
      `SELECT id FROM board_message
       WHERE kind=? AND author_kind=? AND author_session IS ? AND author_run_id IS ?
         AND audience=? AND title=? AND body=?
         AND created_at>=? ORDER BY id DESC`,
    )
    .all(
      kind,
      actor.kind,
      actor.session,
      input.suggestingRunId ?? null,
      audienceExpression,
      input.title,
      input.body,
      new Date(clock - BOARD_DUPLICATE_WINDOW_MS).toISOString(),
    ) as { id: number }[]
  const senderTagsKey = senderTagKey(senderTags)
  const duplicate = duplicateCandidates.find((candidate) => {
    const storedTags = database
      .query(`SELECT kind,value FROM board_message_tag WHERE message_id=? AND origin='sender'`)
      .all(candidate.id) as Pick<BoardTag, 'kind' | 'value'>[]
    return senderTagKey(storedTags) === senderTagsKey
  })
  const decision = authorWindowDecision(actor, clock, Boolean(duplicate), database)
  if (decision === 'drop-duplicate') {
    const reached = (
      database
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
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
    )
    .run(
      kind,
      actor.kind,
      actor.session,
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
  const id = Number(inserted.lastInsertRowid)
  const addTag = database.query(
    `INSERT OR IGNORE INTO board_message_tag (message_id,kind,value,origin) VALUES (?,?,?,?)`,
  )
  for (const tag of tags) addTag.run(id, tag.kind, tag.value, tag.origin)
  const add = database.query(
    `INSERT OR IGNORE INTO board_receipt
     (message_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
     VALUES (?,?,1,NULL,NULL)`,
  )
  const postingRecipients = recipients(audienceExpression, clock, tags, database).filter(
    (reader) => kind !== 'question' || !reader.startsWith('run:'),
  )
  for (const reader of postingRecipients) add.run(id, reader)
  return postNoticeResult(id, false, postingRecipients.length)
}

export function messageRows(): MessageRow[] {
  return db().query('SELECT * FROM board_message ORDER BY id').all() as MessageRow[]
}

export function messageTags(messageId: number): BoardTag[] {
  return db()
    .query('SELECT kind,value,origin FROM board_message_tag WHERE message_id=? ORDER BY rowid')
    .all(messageId) as BoardTag[]
}

export function addressed(message: MessageRow, reader: string, clock: number): boolean {
  return (
    message.audience !== null &&
    recipients(message.audience, clock, messageTags(message.id)).includes(reader)
  )
}

export function rowIsLive(message: MessageRow, clock: number): boolean {
  if (message.kind === 'reply') {
    const root = messageRows().find((candidate) => candidate.id === message.thread_root_id)
    return root ? rowIsLive(root, clock) : false
  }
  if (message.expires_at === null) return false
  return messageIsLive(
    {
      expiresAt: Date.parse(message.expires_at),
      withdrawnAt: message.withdrawn_at ? Date.parse(message.withdrawn_at) : null,
    },
    clock,
  )
}

export function hasReceipt(messageId: number, reader: string): boolean {
  return Boolean(
    db()
      .query('SELECT 1 FROM board_receipt WHERE message_id=? AND reader_session=?')
      .get(messageId, reader),
  )
}

export function originText(message: MessageRow): string {
  if (message.author_kind === 'operator') return 'operator'
  if (message.author_kind === 'worker') return `worker run ${message.author_run_id ?? 'unknown'}`
  return `architect ${message.author_session ?? 'unknown'} (${message.author_harness ?? 'unknown harness'}, ${message.author_project ?? 'unknown project'})`
}
