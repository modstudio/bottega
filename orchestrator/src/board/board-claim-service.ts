import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db, writableDb, writeTransaction } from '../database/db.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import {
  BOARD_CLAIM_DEFAULT_MS,
  type ClaimActor,
  type ClaimCloseReason,
  type ClaimSubject,
  claimCloseReason,
  claimDurationRefusal,
  claimIsLive,
  claimNote,
  claimSubjectsConflict,
  claimTakeDecision,
  mayForceClaim,
  mayReleaseClaim,
  mayRenewClaim,
  parseClaimSubject,
  sameClaimHolder,
} from './board-claim-policy.ts'
import { postNoticeInTransaction } from './board-service.ts'
import {
  BoardPostRateLimitError,
  boardActor,
  type Environment,
  latestRunStatus,
} from './board-store.ts'

type ClaimRow = {
  record_id: string
  project: string
  subject_kind: ClaimSubject['kind']
  subject_value: string
  holder_kind: ClaimActor['kind']
  holder_session: string | null
  note: string | null
  run_record_id: string | null
  duration_ms: number
  taken_at: string
  renewed_at: string
  lapses_at: string
  closed_at: string | null
  close_reason: ClaimCloseReason | null
  superseded_by_claim_record_id: string | null
}

const CLAIM_COLUMNS =
  'record_id,project,subject_kind,subject_value,holder_kind,holder_session,note,run_record_id,duration_ms,taken_at,renewed_at,lapses_at,closed_at,close_reason,superseded_by_claim_record_id'

export type ClaimView = {
  recordId: string
  project: string
  subject: { kind: ClaimSubject['kind']; value: string }
  holder: string
  note: string | null
  runId: string | null
  takenAt: string
  renewedAt: string
  lapsesAt: string
  live: boolean
  closedAt: string | null
  closeReason: ClaimCloseReason | null
  previousClaimRecordIds: string[]
  supersededByClaimRecordId: string | null
}
export type TakeClaimResult = ClaimView & { action: 'taken' | 'renewed' | 'taken-over' }
export type TakeClaimInput = {
  subject: string
  durationMs?: number
  runId?: string
  note?: string
  project?: string
  force?: boolean
}

function claimActor(env: Environment): ClaimActor {
  return boardActor(env)
}

export function claimProject(
  requested: string | undefined,
  env: Environment = process.env,
  cwd = process.cwd(),
): string {
  const actor = claimActor(env)
  if (actor.kind === 'operator') {
    if (!requested) throw new Error('operator claim requires --project <name>')
    if (!projectByName(requested))
      throw new Error(`unknown project ${requested}; run ${PLATFORM_SLUG} project list`)
    return requested
  }
  const held = projectAt(cwd)
  if (!held) throw new Error(`claim project is unknown for ${cwd}; run from a registered project`)
  if (requested && requested !== held.name)
    throw new Error(
      `architect session belongs to project ${held.name}; omit --project or use ${held.name}`,
    )
  return held.name
}

function holder(row: ClaimRow): ClaimActor {
  return row.holder_kind === 'operator'
    ? { kind: 'operator', session: null }
    : { kind: 'architect', session: row.holder_session! }
}

function rowLive(row: ClaimRow, clock: number, database = db()): boolean {
  return claimIsLive({
    closed: row.closed_at !== null,
    lapsesAt: Date.parse(row.lapses_at),
    runStatus: latestRunStatus(row.run_record_id, database),
    now: clock,
  })
}

function view(row: ClaimRow, clock: number, database = db()): ClaimView {
  return {
    recordId: row.record_id,
    project: row.project,
    subject: { kind: row.subject_kind, value: row.subject_value },
    holder: row.holder_kind === 'operator' ? 'operator' : row.holder_session!,
    note: row.note,
    runId: row.run_record_id,
    takenAt: row.taken_at,
    renewedAt: row.renewed_at,
    lapsesAt: row.lapses_at,
    live: rowLive(row, clock, database),
    closedAt: row.closed_at,
    closeReason: row.close_reason,
    previousClaimRecordIds: (
      database
        .query(
          'SELECT record_id FROM board_claim WHERE superseded_by_claim_record_id=? ORDER BY taken_at,record_id',
        )
        .all(row.record_id) as { record_id: string }[]
    ).map(({ record_id }) => record_id),
    supersededByClaimRecordId: row.superseded_by_claim_record_id,
  }
}

function claimByRecordId(recordId: string, database = db()): ClaimRow {
  const row = database
    .query(`SELECT ${CLAIM_COLUMNS} FROM board_claim WHERE record_id=?`)
    .get(recordId) as ClaimRow | null
  if (!row) throw new Error(`no board claim ${recordId}; choose an existing claim UUID`)
  return row
}

function validateRunTie(runId: string | undefined, actor: ClaimActor, database = db()): void {
  if (runId === undefined) return
  const row = database
    .query(
      `SELECT root.session_id FROM run member
       JOIN run root ON root.record_id=COALESCE(member.parent_run_record_id,member.record_id) WHERE member.record_id=?`,
    )
    .get(runId) as { session_id: string | null } | null
  if (!row) throw new Error(`no run ${runId}; use a run owned by this session`)
  if (actor.kind !== 'architect' || row.session_id !== actor.session)
    throw new Error(`run ${runId} is not owned by the claim holder's session`)
}

function linkClaimNotice(
  claimRecordId: string,
  audience: string,
  title: string,
  body: string,
  env: Environment,
  clock: number,
  cwd: string,
  database: ReturnType<typeof writableDb>,
): void {
  const notice = (() => {
    try {
      return postNoticeInTransaction({ audience, title, body }, env, clock, cwd, database)
    } catch (error) {
      if (error instanceof BoardPostRateLimitError) return null
      throw error
    }
  })()
  if (!notice) return
  database
    .query('UPDATE board_message SET claim_record_id=? WHERE record_id=?')
    .run(claimRecordId, notice.recordId)
}

type TakeTransaction = {
  input: TakeClaimInput
  actor: ClaimActor
  subject: ClaimSubject
  note: string | null | undefined
  duration: number
  project: string
  env: Environment
  clock: number
  cwd: string
  database: ReturnType<typeof writableDb>
}

type TakeTransactionResult = {
  row: ClaimRow
  action: TakeClaimResult['action'] | null
  refusal: string | null
}

function conflictingClaims(context: TakeTransaction): {
  conflicts: ClaimRow[]
  exactHeld: ClaimRow | undefined
  foreignLive: ClaimRow[]
} {
  const candidates = context.database
    .query(
      `SELECT ${CLAIM_COLUMNS} FROM board_claim WHERE project_record_id=(SELECT record_id FROM project WHERE name=?) AND closed_at IS NULL ORDER BY taken_at,record_id`,
    )
    .all(context.project) as ClaimRow[]
  const overlaps = candidates.filter((row) =>
    claimSubjectsConflict(context.subject, {
      kind: row.subject_kind,
      value: row.subject_value,
    }),
  )
  const exactHeld = overlaps.find(
    (row) =>
      rowLive(row, context.clock, context.database) &&
      row.subject_kind === context.subject.kind &&
      row.subject_value === context.subject.value &&
      sameClaimHolder(context.actor, holder(row)),
  )
  const conflicts = overlaps.filter((row) => !sameClaimHolder(context.actor, holder(row)))
  const foreignLive = conflicts.filter((row) => rowLive(row, context.clock, context.database))
  return { conflicts, exactHeld, foreignLive }
}

function renewTakenClaim(row: ClaimRow, context: TakeTransaction): TakeTransactionResult {
  if (
    (context.input.durationMs !== undefined && context.input.durationMs !== row.duration_ms) ||
    (context.input.runId !== undefined && context.input.runId !== row.run_record_id) ||
    (context.note !== undefined && context.note !== row.note)
  )
    throw new Error(
      `claim ${row.record_id} (${row.subject_kind}:${row.subject_value}) already holds this subject with different terms; release it and take it again`,
    )
  const renewedAt = new Date(context.clock).toISOString()
  context.database
    .query('UPDATE board_claim SET renewed_at=?,lapses_at=? WHERE record_id=?')
    .run(renewedAt, new Date(context.clock + row.duration_ms).toISOString(), row.record_id)
  return { row: claimByRecordId(row.record_id, context.database), action: 'renewed', refusal: null }
}

function tellConflictingHolders(conflicts: ClaimRow[], context: TakeTransaction): void {
  for (const conflict of conflicts) {
    if (conflict.holder_kind !== 'architect') continue
    linkClaimNotice(
      conflict.record_id,
      `session:${conflict.holder_session}`,
      'Conflicting claim attempt',
      `${context.actor.kind === 'operator' ? 'The operator' : `Session ${context.actor.session}`} attempted to claim ${context.input.subject} in ${context.project}; it conflicts with claim ${conflict.record_id} (${conflict.subject_kind}:${conflict.subject_value}).`,
      context.env,
      context.clock,
      context.cwd,
      context.database,
    )
  }
}

function refusedTake(conflicts: ClaimRow[], context: TakeTransaction): TakeTransactionResult {
  tellConflictingHolders(conflicts, context)
  const details = conflicts.map((conflict) => {
    const named =
      conflict.holder_kind === 'operator' ? 'operator' : `session ${conflict.holder_session}`
    const remedy =
      conflict.holder_kind === 'architect'
        ? `ask with ${PLATFORM_SLUG} board ask --audience session:${conflict.holder_session}, or wait`
        : 'wait for the operator claim to lapse'
    return `${named} until ${conflict.lapses_at} (${remedy})`
  })
  return {
    row: conflicts[0]!,
    action: null,
    refusal: `claim conflicts with: ${details.join('; ')}`,
  }
}

function tellTakenOverHolder(claim: ClaimRow, context: TakeTransaction): void {
  if (claim.holder_kind !== 'architect') return
  linkClaimNotice(
    claim.record_id,
    `session:${claim.holder_session}`,
    'Claim taken over',
    `${context.actor.kind === 'operator' ? 'The operator' : `Session ${context.actor.session}`} took over claim ${claim.record_id} (${claim.subject_kind}:${claim.subject_value}) with ${context.input.subject} in ${context.project}.`,
    context.env,
    context.clock,
    context.cwd,
    context.database,
  )
}

function insertTakenClaim(conflicts: ClaimRow[], context: TakeTransaction): TakeTransactionResult {
  const now = new Date(context.clock).toISOString()
  const recordId = newRecordId()
  context.database
    .query(
      `INSERT INTO board_claim
       (record_id,project,project_record_id,subject_kind,subject_value,holder_kind,holder_session,note,run_record_id,duration_ms,
        taken_at,renewed_at,lapses_at,closed_at,close_reason,superseded_by_claim_record_id)
       VALUES (?,?,(SELECT record_id FROM project WHERE name=?),?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)`,
    )
    .run(
      recordId,
      context.project,
      context.project,
      context.subject.kind,
      context.subject.value,
      context.actor.kind,
      context.actor.session,
      context.note ?? null,
      context.input.runId ?? null,
      context.duration,
      now,
      now,
      new Date(context.clock + context.duration).toISOString(),
    )
  const row = claimByRecordId(recordId, context.database)
  const close = context.database.query(
    'UPDATE board_claim SET closed_at=?,close_reason=?,superseded_by_claim_record_id=? WHERE record_id=?',
  )
  for (const conflict of conflicts) {
    const endedReason = claimCloseReason({
      closed: false,
      lapsesAt: Date.parse(conflict.lapses_at),
      runStatus: latestRunStatus(conflict.run_record_id, context.database),
      now: context.clock,
    })
    close.run(now, endedReason ?? 'taken-over', row.record_id, conflict.record_id)
    tellTakenOverHolder(conflict, context)
  }
  return { row, action: conflicts.length ? 'taken-over' : 'taken', refusal: null }
}

function takeClaimInTransaction(context: TakeTransaction): TakeTransactionResult {
  const { conflicts, exactHeld, foreignLive } = conflictingClaims(context)
  const decision = claimTakeDecision({
    sameHolderSameSubject: exactHeld !== undefined,
    conflictingClaim: conflicts.length > 0,
    foreignLiveConflict: foreignLive.length > 0,
    force: Boolean(context.input.force),
    actorKind: context.actor.kind,
  })
  if (decision === 'renew') return renewTakenClaim(exactHeld!, context)
  if (decision === 'refuse') return refusedTake(foreignLive, context)
  return insertTakenClaim(decision === 'take-over' ? conflicts : [], context)
}

export function takeClaim(
  input: TakeClaimInput,
  env: Environment = process.env,
  clock = Date.now(),
  cwd = process.cwd(),
): TakeClaimResult {
  const actor = claimActor(env)
  if (input.force && !mayForceClaim(actor)) throw new Error('only the operator may use --force')
  const subject = parseClaimSubject(input.subject)
  const note = claimNote(input.note)
  const duration = input.durationMs ?? BOARD_CLAIM_DEFAULT_MS
  const durationRefusal = claimDurationRefusal(duration)
  if (durationRefusal) throw new Error(durationRefusal)
  const project = claimProject(input.project, env, cwd)
  const database = writableDb()
  validateRunTie(input.runId, actor, database)
  const outcome = writeTransaction(
    () =>
      takeClaimInTransaction({
        input,
        actor,
        subject,
        note,
        duration,
        project,
        env,
        clock,
        cwd,
        database,
      }),
    database,
  )
  if (outcome.refusal) throw new Error(outcome.refusal)
  return { ...view(outcome.row, clock, database), action: outcome.action! }
}

export function renewClaim(
  recordId: string,
  env: Environment = process.env,
  clock = Date.now(),
): ClaimView {
  const actor = claimActor(env)
  const database = writableDb()
  return writeTransaction(() => {
    const row = claimByRecordId(recordId, database)
    if (!rowLive(row, clock, database))
      throw new Error(
        `claim ${recordId} (${row.subject_kind}:${row.subject_value}) is no longer live; take the subject again`,
      )
    if (!mayRenewClaim(actor, holder(row)))
      throw new Error(
        `only the claim holder may renew claim ${recordId} (${row.subject_kind}:${row.subject_value})`,
      )
    const at = new Date(clock).toISOString()
    database
      .query('UPDATE board_claim SET renewed_at=?,lapses_at=? WHERE record_id=?')
      .run(at, new Date(clock + row.duration_ms).toISOString(), recordId)
    return view(claimByRecordId(recordId, database), clock, database)
  }, database)
}

export function releaseClaim(
  recordId: string,
  env: Environment = process.env,
  clock = Date.now(),
): ClaimView {
  const actor = claimActor(env)
  const database = writableDb()
  return writeTransaction(() => {
    const row = claimByRecordId(recordId, database)
    if (!rowLive(row, clock, database))
      throw new Error(
        `claim ${recordId} (${row.subject_kind}:${row.subject_value}) is no longer live`,
      )
    if (!mayReleaseClaim(actor, holder(row)))
      throw new Error(
        `only the claim holder or operator may release claim ${recordId} (${row.subject_kind}:${row.subject_value})`,
      )
    database
      .query("UPDATE board_claim SET closed_at=?,close_reason='released' WHERE record_id=?")
      .run(new Date(clock).toISOString(), recordId)
    return view(claimByRecordId(recordId, database), clock, database)
  }, database)
}

export function listClaims(
  project: string | undefined,
  all = false,
  env: Environment = process.env,
  clock = Date.now(),
  cwd = process.cwd(),
): { claims: ClaimView[] } {
  const name = claimProject(project, env, cwd)
  const rows = db()
    .query(
      `SELECT ${CLAIM_COLUMNS} FROM board_claim WHERE project_record_id=(SELECT record_id FROM project WHERE name=?) ORDER BY taken_at,record_id`,
    )
    .all(name) as ClaimRow[]
  const claims = rows.map((row) => view(row, clock)).filter((row) => all || row.live)
  return { claims }
}

export function releaseTaskClaims(
  key: string,
  project: string,
  env: Environment = process.env,
  clock = Date.now(),
): { released: number } {
  claimActor(env)
  if (!projectByName(project))
    throw new Error(`unknown project ${project}; run ${PLATFORM_SLUG} project list`)
  const database = writableDb()
  return writeTransaction(() => {
    const rows = database
      .query(
        `SELECT ${CLAIM_COLUMNS} FROM board_claim WHERE project_record_id=(SELECT record_id FROM project WHERE name=?) AND subject_kind='task' AND subject_value=? AND closed_at IS NULL`,
      )
      .all(project, key) as ClaimRow[]
    const ids = rows.filter((row) => rowLive(row, clock, database)).map((row) => row.record_id)
    const close = database.query(
      "UPDATE board_claim SET closed_at=?,close_reason='task-closed' WHERE record_id=?",
    )
    for (const id of ids) close.run(new Date(clock).toISOString(), id)
    return { released: ids.length }
  }, database)
}

export function stampEndedClaims(clock = Date.now()): number {
  const database = writableDb()
  return writeTransaction(() => {
    const rows = database
      .query(`SELECT ${CLAIM_COLUMNS} FROM board_claim WHERE closed_at IS NULL`)
      .all() as ClaimRow[]
    const close = database.query(
      'UPDATE board_claim SET closed_at=?,close_reason=? WHERE record_id=?',
    )
    let count = 0
    for (const row of rows) {
      const reason = claimCloseReason({
        closed: false,
        lapsesAt: Date.parse(row.lapses_at),
        runStatus: latestRunStatus(row.run_record_id, database),
        now: clock,
      })
      if (!reason) continue
      close.run(new Date(clock).toISOString(), reason, row.record_id)
      count++
    }
    return count
  }, database)
}
