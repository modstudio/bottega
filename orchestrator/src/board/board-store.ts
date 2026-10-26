import { hostname } from 'node:os'
import {
  BOARD_DEFAULT_ACK_DEADLINE_MS,
  boardDefaultExpiryMs,
} from '../../../shared/board-duration.ts'
import { type BoardPurpose, defaultBoardPurpose } from '../../../shared/board-purpose.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { classifyCaller } from '../caller-classification.ts'
import { db, SESSION_LIVE_MS, type writableDb } from '../database/db.ts'
import { nextEntityNumber } from '../database/entity-number.ts'
import { projectAt, projects } from '../project/projects.ts'
import { claimIsLive } from './board-claim-policy.ts'
import { boardContext, boardRunContext } from './board-context.ts'
import {
  type Audience,
  acknowledgementRefusal,
  architectIdentity,
  architectsPostingRefusal,
  BOARD_DUPLICATE_WINDOW_MS,
  BOARD_POST_RATE_WINDOW_MS,
  messageIsLive,
  OPERATOR_READER,
  parseAudience,
  postDecision,
  resolveAudience,
  runAudienceRefusal,
  standingPostingRefusal,
  validatePostNoticeInput,
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
export type BoardOrigin = {
  kind: string
  session: string | null
  harness: string | null
  project: string | null
  runId: string | null
}
export type PostNoticeResult = {
  recordId: string
  number: number
  dropped: boolean
  reached: number
  warning?: string
}
export class BoardPostRateLimitError extends Error {
  constructor() {
    super('board post rate limit reached; retry after the ten-minute author window')
    this.name = 'BoardPostRateLimitError'
  }
}
export type PostNoticeInput = SenderBoardTags & {
  audience: string
  title: string
  body: string
  ackRequired?: boolean
  deadlineMs?: number
  expiresMs?: number
  purpose?: BoardPurpose | string
  suggestingRunId?: string
}
export type MessageRow = {
  record_id: string
  number: number
  kind: string
  purpose: BoardPurpose | null
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
  author_run_record_id: string | null
  thread_root_record_id: string | null
  accepted_reply_record_id: string | null
  accepted_by: string | null
  accepted_at: string | null
  note_record_id: string | null
  note_label: string | null
  note_pending_error: string | null
  note_filing_started_at: string | null
  claim_record_id: string | null
}

export const BOARD_MESSAGE_COLUMNS =
  'record_id,number,kind,purpose,author_kind,author_session,audience,title,body,ack_required,ack_deadline,expires_at,created_at,withdrawn_at,author_harness,author_project,author_run_record_id,thread_root_record_id,accepted_reply_record_id,accepted_by,accepted_at,note_record_id,note_label,note_pending_error,note_filing_started_at,claim_record_id'

function rootPurpose(
  kind: 'notice' | 'question',
  input: PostNoticeInput,
  audience: Audience,
  actor: BoardActor,
  authorProject: string | null,
): BoardPurpose {
  const purpose =
    kind === 'question' ? 'request' : defaultBoardPurpose(input.purpose, Boolean(input.ackRequired))
  const refusal =
    acknowledgementRefusal({
      ackRequired: Boolean(input.ackRequired),
      purpose,
      audience,
      authorKind: actor.kind,
      authorProject,
      topics: input.topics,
    }) ??
    standingPostingRefusal({
      purpose,
      audience,
      authorKind: actor.kind,
      authorProject,
      ackRequired: Boolean(input.ackRequired),
      topics: input.topics,
    })
  if (refusal) throw new Error(refusal)
  return purpose
}

export function boardReaderBeganAt(reader: string, database = db()): string | null {
  const run = /^run:([0-9a-f-]{36})$/.exec(reader)
  if (run)
    return (
      (
        database.query('SELECT started_at FROM run WHERE record_id=?').get(run[1]!) as {
          started_at: string
        } | null
      )?.started_at ?? null
    )
  if (reader === OPERATOR_READER) return null
  return (
    (
      database
        .query('SELECT COALESCE(first_seen,last_seen) began_at FROM presence WHERE session_id=?')
        .get(reader) as { began_at: string } | null
    )?.began_at ?? null
  )
}

const NO_REACH_WARNING = 'reached no live session; re-address it or wait for a matching session'

export function boardActor(env: Environment = process.env): BoardActor {
  const caller = classifyCaller(env)
  if (caller.kind === 'worker')
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
  if (caller.kind === 'unsupported-harness')
    throw new Error(
      `this harness has no recognized architect identity (${caller.markers.join(', ')}); use a supported architect harness or post from an operator terminal`,
    )
  if (caller.kind === 'reserved-operator-session')
    throw new Error(
      'operator: session ids are reserved; use a real architect session id or post from an operator terminal',
    )
  return { kind: 'operator', session: null }
}

function architectPresenceFacts(database: ReturnType<typeof db>) {
  return (
    database
      .query(
        `SELECT presence.session_id,presence.project,presence.machine,presence.last_seen,
                presence.current_task_key,session_seen.last_seen AS session_last_seen
         FROM presence LEFT JOIN session_seen ON session_seen.session_id=presence.session_id`,
      )
      .all() as {
      session_id: string
      project: string
      machine: string
      last_seen: string
      current_task_key: string | null
      session_last_seen: string | null
    }[]
  ).map((row) => ({
    reader: row.session_id,
    role: 'architect' as const,
    project: row.project,
    machine: row.machine,
    lastSeen: Math.max(
      Date.parse(row.last_seen),
      row.session_last_seen ? Date.parse(row.session_last_seen) : Number.NEGATIVE_INFINITY,
    ),
    taskKeys: new Set(row.current_task_key ? [row.current_task_key] : []),
  }))
}

function workerPresenceFacts(database: ReturnType<typeof db>) {
  const liveTurns = database
    .query(
      `WITH ranked AS (
         SELECT record_id,COALESCE(parent_run_record_id,record_id) root_id,status,
                ROW_NUMBER() OVER (
                  PARTITION BY COALESCE(parent_run_record_id,record_id) ORDER BY turn DESC,number DESC
                ) rank
         FROM run
       ), live_roots AS (
         SELECT root_id FROM ranked WHERE rank=1 AND status IN ('running','asking')
       )
       SELECT run.record_id,run.record_id,COALESCE(run.parent_run_record_id,run.record_id) root_id,run.repo,run.status,run.turn,
              root.launch_key,root.record_id root_record_id
       FROM run JOIN live_roots ON live_roots.root_id=COALESCE(run.parent_run_record_id,run.record_id)
       JOIN run root ON root.record_id=COALESCE(run.parent_run_record_id,run.record_id)
       ORDER BY root_id,run.turn DESC`,
    )
    .all() as {
    id: string
    record_id: string | null
    root_id: string
    repo: string | null
    status: string
    turn: number
    launch_key: string | null
    root_record_id: string | null
  }[]
  const workers = new Map<string, (typeof liveTurns)[number] & { runIds: Set<string> }>()
  for (const row of liveTurns) {
    const current = workers.get(row.root_id)
    if (!current)
      workers.set(row.root_id, {
        ...row,
        runIds: new Set([
          row.id,
          row.root_id,
          ...(row.record_id ? [row.record_id] : []),
          ...(row.root_record_id ? [row.root_record_id] : []),
        ]),
      })
    else {
      current.runIds.add(row.id)
      if (row.record_id) current.runIds.add(row.record_id)
    }
  }
  return [...workers.values()].map((row) => ({
    reader: `run:${row.root_id}`,
    role: 'worker' as const,
    project: row.repo ?? '',
    machine: hostname(),
    live: true,
    runIds: row.runIds,
    taskKeys: new Set(row.launch_key ? [row.launch_key] : []),
  }))
}

function claimPresenceFacts(database: ReturnType<typeof db>, at: number) {
  const claims = database
    .query(
      `SELECT holder_kind,holder_session,subject_value,lapses_at,run_record_id
       FROM board_claim WHERE closed_at IS NULL AND subject_kind='task'`,
    )
    .all() as {
    holder_kind: 'operator' | 'architect'
    holder_session: string | null
    subject_value: string
    lapses_at: string
    run_record_id: string | null
  }[]
  const claimReaders = new Map<string, { role: 'operator' | 'architect'; taskKeys: Set<string> }>()
  for (const claim of claims) {
    if (
      !claimIsLive({
        closed: false,
        lapsesAt: Date.parse(claim.lapses_at),
        runStatus: latestRunStatus(claim.run_record_id, database),
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
  return [...claimReaders].map(([reader, fact]) => ({
    reader,
    role: fact.role,
    project: '',
    machine: hostname(),
    live: true,
    taskKeys: fact.taskKeys,
    taskAudienceOnly: true,
  }))
}

export function presenceFacts(database = db(), at = Date.now()) {
  return [
    ...architectPresenceFacts(database),
    ...workerPresenceFacts(database),
    ...claimPresenceFacts(database, at),
  ]
}

export function latestRunStatus(
  runId: string | null,
  database: ReturnType<typeof db> = db(),
): string | null {
  if (runId === null) return null
  const row = database
    .query(
      `SELECT latest.status FROM run member
       JOIN run latest ON latest.record_id=(
         SELECT record_id FROM run
         WHERE record_id=COALESCE(member.parent_run_record_id,member.record_id)
            OR parent_run_record_id=COALESCE(member.parent_run_record_id,member.record_id)
         ORDER BY turn DESC,number DESC LIMIT 1)
       WHERE member.record_id=?`,
    )
    .get(runId) as { status: string } | null
  return row?.status ?? 'missing'
}

export function recipients(
  audienceExpression: string,
  at: number,
  tags: BoardTag[],
  database = db(),
  facts = presenceFacts(database, at),
  postingProject: string | null = null,
): string[] {
  const audience = parseAudience(audienceExpression)
  const coarse = resolveAudience(audience, facts, at, SESSION_LIVE_MS, postingProject)
  if (audience.kind !== 'project' && audience.kind !== 'workers') return coarse
  return coarse.filter((reader) => {
    const run = /^run:([0-9a-f-]{36})$/i.exec(reader)
    return boardNoticeMatches(
      tags,
      run ? boardRunContext(run[1]!, database) : boardContext(reader, at, database),
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
  const project = projectAt(cwd)
  return {
    harness: actor.kind === 'operator' ? null : architectIdentity(env)!.harness,
    project: project?.name ?? null,
  }
}

function validateArchitectAudience(
  actor: BoardActor,
  audience: Audience,
  project: string | null,
  cwd: string,
  database: ReturnType<typeof writableDb>,
): void {
  if (actor.kind === 'architect' && !project && audience.kind !== 'architects')
    throw new Error(
      `architect posting project is unknown for ${cwd}; post from a registered project or run ${PLATFORM_SLUG} project add first`,
    )
  const refusal = architectsPostingRefusal(audience, project)
  if (refusal) throw new Error(refusal)
  if (audience.kind !== 'architects') return
  if (audience.value && !projects(undefined, database).some((item) => item.name === audience.value))
    throw new Error(
      `unknown board project ${audience.value}; run ${PLATFORM_SLUG} project list and use architects:<registered-project>`,
    )
}

export function validateRunAudience(
  audience: Audience,
  actor: BoardActor,
  database: ReturnType<typeof writableDb>,
): void {
  const owner =
    audience.kind === 'run' && typeof audience.value === 'string'
      ? runOwnerSession(audience.value, database)
      : null
  const refusal = runAudienceRefusal(audience, actor.kind, actor.session, owner)
  if (refusal) throw new Error(refusal)
}

function runOwnerSession(runId: string, database: ReturnType<typeof writableDb>): string | null {
  const row = database
    .query(
      `SELECT root.session_id
       FROM run turn JOIN run root ON root.record_id=COALESCE(turn.parent_run_record_id,turn.record_id)
       WHERE turn.record_id=?`,
    )
    .get(runId) as { session_id: string | null } | null
  return row?.session_id ?? null
}

function postNoticeResult(
  recordId: string,
  number: number,
  dropped: boolean,
  reached: number,
): PostNoticeResult {
  return {
    recordId,
    number,
    dropped,
    reached,
    ...(reached === 0 ? { warning: NO_REACH_WARNING } : {}),
  }
}

function refreshPostingPresence(
  database: ReturnType<typeof writableDb>,
  actor: BoardActor,
  origin: ReturnType<typeof resolvePostOrigin>,
  machine: string,
  cwd: string,
  at: string,
): void {
  if (actor.kind !== 'architect' || !origin.project) return
  const current = database
    .query(
      `SELECT launch_key FROM run
       WHERE session_id=? AND status IN ('running','asking') AND launch_key IS NOT NULL
       ORDER BY number DESC LIMIT 1`,
    )
    .get(actor.session) as { launch_key: string } | null
  database
    .query(
      `INSERT INTO presence
       (session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,?,'architect',?, ?, (SELECT record_id FROM project WHERE name=?), ?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET harness=excluded.harness, role=excluded.role,
         machine=excluded.machine, project=excluded.project,
         project_record_id=excluded.project_record_id, cwd=excluded.cwd,
         current_task_key=excluded.current_task_key, last_seen=excluded.last_seen`,
    )
    .run(
      actor.session,
      origin.harness,
      machine,
      origin.project,
      origin.project,
      cwd,
      current?.launch_key ?? null,
      at,
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

function recordRecipients(
  messageRecordId: string,
  audience: string,
  kind: 'notice' | 'question',
  clock: number,
  tags: BoardTag[],
  project: string | null,
  database: ReturnType<typeof writableDb>,
): number {
  const readers = recipients(
    audience,
    clock,
    tags,
    database,
    presenceFacts(database, clock),
    project,
  ).filter((reader) => kind !== 'question' || !reader.startsWith('run:'))
  const add = database.query(
    `INSERT OR IGNORE INTO board_receipt
     (record_id,message_record_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
     VALUES (?,?,?,1,NULL,NULL)`,
  )
  for (const reader of readers) add.run(newRecordId(), messageRecordId, reader)
  return readers.length
}

function duplicateRoot(
  database: ReturnType<typeof writableDb>,
  input: {
    kind: 'notice' | 'question'
    purpose: BoardPurpose
    actor: BoardActor
    suggestingRunId: string | null
    project: string | null
    audience: string
    title: string
    body: string
    clock: number
    senderTags: BoardTag[]
  },
): { record_id: string; number: number } | undefined {
  const candidates = database
    .query(
      `SELECT record_id,number FROM board_message
       WHERE kind=? AND purpose=? AND author_kind=? AND author_session IS ? AND author_run_record_id IS ?
         AND author_project_record_id IS (SELECT record_id FROM project WHERE name IS ?)
         AND audience=? AND title=? AND body=? AND created_at>=?
       ORDER BY created_at DESC,number DESC`,
    )
    .all(
      input.kind,
      input.purpose,
      input.actor.kind,
      input.actor.session,
      input.suggestingRunId,
      input.project,
      input.audience,
      input.title,
      input.body,
      new Date(input.clock - BOARD_DUPLICATE_WINDOW_MS).toISOString(),
    ) as { record_id: string; number: number }[]
  const senderTagsKey = senderTagKey(input.senderTags)
  return candidates.find((candidate) => {
    const storedTags = database
      .query(
        `SELECT kind,value FROM board_message_tag WHERE message_record_id=? AND origin='sender'`,
      )
      .all(candidate.record_id) as Pick<BoardTag, 'kind' | 'value'>[]
    return senderTagKey(storedTags) === senderTagsKey
  })
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
  validateRunAudience(audience, actor, database)
  const origin = resolvePostOrigin(actor, env, cwd)
  validateArchitectAudience(actor, audience, origin.project, cwd, database)
  const purpose = rootPurpose(kind, input, audience, actor, origin.project)
  const senderTags = senderBoardTags(input)
  const deadlineMs = input.deadlineMs ?? BOARD_DEFAULT_ACK_DEADLINE_MS
  const expiresMs = input.expiresMs ?? boardDefaultExpiryMs(purpose)
  if (input.ackRequired && deadlineMs > expiresMs)
    throw new Error(
      `ack deadline ${deadlineMs}ms is later than expiry ${expiresMs}ms; set --deadline no later than --expires`,
    )
  const duplicate = duplicateRoot(database, {
    kind,
    purpose,
    actor,
    suggestingRunId: input.suggestingRunId ?? null,
    project: origin.project,
    audience: audienceExpression,
    title: input.title,
    body: input.body,
    clock,
    senderTags,
  })
  const decision = authorWindowDecision(actor, clock, Boolean(duplicate), database)
  if (decision === 'drop-duplicate') {
    const reached = (
      database
        .query(
          'SELECT COUNT(*) count FROM board_receipt WHERE message_record_id=? AND audience_at_posting=1',
        )
        .get(duplicate!.record_id) as { count: number }
    ).count
    return postNoticeResult(duplicate!.record_id, duplicate!.number, true, reached)
  }
  if (decision === 'rate-limited') throw new BoardPostRateLimitError()
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
  const inserted = insertRootRow(
    kind,
    purpose,
    actor,
    origin,
    audienceExpression,
    input,
    ackRequired,
    deadline,
    expiresAt,
    createdAt,
    tags,
    database,
  )
  const reached = recordRecipients(
    inserted.recordId,
    audienceExpression,
    kind,
    clock,
    tags,
    origin.project,
    database,
  )
  return postNoticeResult(inserted.recordId, inserted.number, false, reached)
}

function insertRootRow(
  kind: 'notice' | 'question',
  purpose: BoardPurpose,
  actor: BoardActor,
  origin: Pick<BoardOrigin, 'harness' | 'project'>,
  audienceExpression: string,
  input: PostNoticeInput,
  ackRequired: boolean,
  deadline: string | null,
  expiresAt: string,
  createdAt: string,
  tags: BoardTag[],
  database: ReturnType<typeof writableDb>,
): { recordId: string; number: number } {
  const recordId = newRecordId()
  const number = nextEntityNumber(database, 'board_message')
  database
    .query(
      `INSERT INTO board_message
         (record_id,number,kind,purpose,author_kind,author_session,author_run_record_id,author_harness,author_project,
          author_project_record_id,audience,title,body,
          ack_required,ack_deadline,expires_at,created_at,withdrawn_at)
         VALUES (?,?,?,?,?,?,?,?,?,(SELECT record_id FROM project WHERE name IS ?),?,?,?,?,?,?,?,NULL)`,
    )
    .run(
      recordId,
      number,
      kind,
      purpose,
      actor.kind,
      actor.session,
      input.suggestingRunId ?? null,
      origin.harness,
      origin.project,
      origin.project,
      audienceExpression,
      input.title,
      input.body,
      ackRequired ? 1 : 0,
      deadline,
      expiresAt,
      createdAt,
    )
  const addTag = database.query(
    `INSERT OR IGNORE INTO board_message_tag (record_id,message_record_id,kind,value,origin) VALUES (?,?,?,?,?)`,
  )
  for (const tag of tags) addTag.run(newRecordId(), recordId, tag.kind, tag.value, tag.origin)
  return { recordId, number }
}

export function messageRows(database = db()): MessageRow[] {
  return database
    .query(`SELECT ${BOARD_MESSAGE_COLUMNS} FROM board_message ORDER BY number`)
    .all() as MessageRow[]
}

export function messageTags(messageRecordId: string, database = db()): BoardTag[] {
  return database
    .query(
      'SELECT kind,value,origin FROM board_message_tag WHERE message_record_id=? ORDER BY rowid',
    )
    .all(messageRecordId) as BoardTag[]
}

export function addressed(
  message: MessageRow,
  reader: string,
  clock: number,
  database = db(),
): boolean {
  return (
    message.audience !== null &&
    recipients(
      message.audience,
      clock,
      messageTags(message.record_id, database),
      database,
      presenceFacts(database, clock),
      message.author_project,
    ).includes(reader)
  )
}

export function rowIsLive(message: MessageRow, clock: number, database = db()): boolean {
  if (message.kind === 'reply') {
    const root = messageRows(database).find(
      (candidate) => candidate.record_id === message.thread_root_record_id,
    )
    return root ? rowIsLive(root, clock, database) : false
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

export function hasReceipt(messageRecordId: string, reader: string, database = db()): boolean {
  return Boolean(
    database
      .query('SELECT 1 FROM board_receipt WHERE message_record_id=? AND reader_session=?')
      .get(messageRecordId, reader),
  )
}

export function boardOrigin(message: MessageRow): BoardOrigin {
  return {
    kind: message.author_kind,
    session: message.author_session,
    harness: message.author_harness,
    project: message.author_project,
    runId: message.author_run_record_id === null ? null : String(message.author_run_record_id),
  }
}

export function originText(origin: BoardOrigin): string {
  if (origin.kind === 'operator') return 'operator'
  if (origin.kind === 'worker') return `worker run ${origin.runId ?? 'unknown'}`
  return `architect ${origin.session ?? 'unknown'} (${origin.harness ?? 'unknown harness'}, ${origin.project ?? 'unknown project'})`
}
