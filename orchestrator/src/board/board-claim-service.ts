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
  id: number
  project: string
  subject_kind: ClaimSubject['kind']
  subject_value: string
  holder_kind: ClaimActor['kind']
  holder_session: string | null
  note: string | null
  run_id: number | null
  duration_ms: number
  taken_at: string
  renewed_at: string
  lapses_at: string
  closed_at: string | null
  close_reason: ClaimCloseReason | null
  superseded_by_claim_id: number | null
}

export type ClaimView = {
  id: number
  project: string
  subject: { kind: ClaimSubject['kind']; value: string }
  holder: string
  note: string | null
  runId: number | null
  takenAt: string
  renewedAt: string
  lapsesAt: string
  live: boolean
  closedAt: string | null
  closeReason: ClaimCloseReason | null
  previousClaimIds: number[]
  supersededByClaimId: number | null
}
export type TakeClaimResult = ClaimView & { action: 'taken' | 'renewed' | 'taken-over' }
export type TakeClaimInput = {
  subject: string
  durationMs?: number
  runId?: number
  note?: string
  project?: string
  force?: boolean
}

function claimActor(env: Environment): ClaimActor {
  return boardActor(env)
}

function claimProject(actor: ClaimActor, requested: string | undefined, cwd: string): string {
  if (actor.kind === 'operator') {
    if (!requested) throw new Error('operator claim requires --project <name>')
    if (!projectByName(requested))
      throw new Error(`unknown project ${requested}; run orch project list`)
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
    runStatus: latestRunStatus(row.run_id, database),
    now: clock,
  })
}

function view(row: ClaimRow, clock: number, database = db()): ClaimView {
  return {
    id: row.id,
    project: row.project,
    subject: { kind: row.subject_kind, value: row.subject_value },
    holder: row.holder_kind === 'operator' ? 'operator' : row.holder_session!,
    note: row.note,
    runId: row.run_id,
    takenAt: row.taken_at,
    renewedAt: row.renewed_at,
    lapsesAt: row.lapses_at,
    live: rowLive(row, clock, database),
    closedAt: row.closed_at,
    closeReason: row.close_reason,
    previousClaimIds: (
      database
        .query('SELECT id FROM board_claim WHERE superseded_by_claim_id=? ORDER BY id')
        .all(row.id) as { id: number }[]
    ).map(({ id }) => id),
    supersededByClaimId: row.superseded_by_claim_id,
  }
}

function claimById(id: number, database = db()): ClaimRow {
  const row = database.query('SELECT * FROM board_claim WHERE id=?').get(id) as ClaimRow | null
  if (!row) throw new Error(`no board claim ${id}; choose an existing claim id`)
  return row
}

function validateRunTie(runId: number | undefined, actor: ClaimActor, database = db()): void {
  if (runId === undefined) return
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('claim run must be a positive id')
  const row = database
    .query(
      `SELECT root.session_id FROM run member
       JOIN run root ON root.id=COALESCE(member.parent_run_id,member.id) WHERE member.id=?`,
    )
    .get(runId) as { session_id: string | null } | null
  if (!row) throw new Error(`no run ${runId}; use a run owned by this session`)
  if (actor.kind !== 'architect' || row.session_id !== actor.session)
    throw new Error(`run ${runId} is not owned by the claim holder's session`)
}

function linkClaimNotice(
  claimId: number,
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
  database.query('UPDATE board_message SET claim_id=? WHERE id=?').run(claimId, notice.id)
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
    .query('SELECT * FROM board_claim WHERE project=? AND closed_at IS NULL ORDER BY id')
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
    (context.input.runId !== undefined && context.input.runId !== row.run_id) ||
    (context.note !== undefined && context.note !== row.note)
  )
    throw new Error(
      `claim ${row.id} already holds this subject with different terms; release it and take it again`,
    )
  const renewedAt = new Date(context.clock).toISOString()
  context.database
    .query('UPDATE board_claim SET renewed_at=?,lapses_at=? WHERE id=?')
    .run(renewedAt, new Date(context.clock + row.duration_ms).toISOString(), row.id)
  return { row: claimById(row.id, context.database), action: 'renewed', refusal: null }
}

function tellConflictingHolders(conflicts: ClaimRow[], context: TakeTransaction): void {
  for (const conflict of conflicts) {
    if (conflict.holder_kind !== 'architect') continue
    linkClaimNotice(
      conflict.id,
      `session:${conflict.holder_session}`,
      'Conflicting claim attempt',
      `${context.actor.kind === 'operator' ? 'The operator' : `Session ${context.actor.session}`} attempted to claim ${context.input.subject} in ${context.project}; it conflicts with claim ${conflict.id}.`,
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
        ? `ask with orch board ask --audience session:${conflict.holder_session}, or wait`
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
    claim.id,
    `session:${claim.holder_session}`,
    'Claim taken over',
    `${context.actor.kind === 'operator' ? 'The operator' : `Session ${context.actor.session}`} took over claim ${claim.id} with ${context.input.subject} in ${context.project}.`,
    context.env,
    context.clock,
    context.cwd,
    context.database,
  )
}

function insertTakenClaim(conflicts: ClaimRow[], context: TakeTransaction): TakeTransactionResult {
  const now = new Date(context.clock).toISOString()
  const inserted = context.database
    .query(
      `INSERT INTO board_claim
       (project,subject_kind,subject_value,holder_kind,holder_session,note,run_id,duration_ms,
        taken_at,renewed_at,lapses_at,closed_at,close_reason,superseded_by_claim_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)`,
    )
    .run(
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
  const row = claimById(Number(inserted.lastInsertRowid), context.database)
  const close = context.database.query(
    'UPDATE board_claim SET closed_at=?,close_reason=?,superseded_by_claim_id=? WHERE id=?',
  )
  for (const conflict of conflicts) {
    const endedReason = claimCloseReason({
      closed: false,
      lapsesAt: Date.parse(conflict.lapses_at),
      runStatus: latestRunStatus(conflict.run_id, context.database),
      now: context.clock,
    })
    close.run(now, endedReason ?? 'taken-over', row.id, conflict.id)
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
  const project = claimProject(actor, input.project, cwd)
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
  id: number,
  env: Environment = process.env,
  clock = Date.now(),
): ClaimView {
  const actor = claimActor(env)
  const database = writableDb()
  return writeTransaction(() => {
    const row = claimById(id, database)
    if (!rowLive(row, clock, database))
      throw new Error(`claim ${id} is no longer live; take the subject again`)
    if (!mayRenewClaim(actor, holder(row)))
      throw new Error(`only the claim holder may renew claim ${id}`)
    const at = new Date(clock).toISOString()
    database
      .query('UPDATE board_claim SET renewed_at=?,lapses_at=? WHERE id=?')
      .run(at, new Date(clock + row.duration_ms).toISOString(), id)
    return view(claimById(id, database), clock, database)
  }, database)
}

export function releaseClaim(
  id: number,
  env: Environment = process.env,
  clock = Date.now(),
): ClaimView {
  const actor = claimActor(env)
  const database = writableDb()
  return writeTransaction(() => {
    const row = claimById(id, database)
    if (!rowLive(row, clock, database)) throw new Error(`claim ${id} is no longer live`)
    if (!mayReleaseClaim(actor, holder(row)))
      throw new Error(`only the claim holder or operator may release claim ${id}`)
    database
      .query("UPDATE board_claim SET closed_at=?,close_reason='released' WHERE id=?")
      .run(new Date(clock).toISOString(), id)
    return view(claimById(id, database), clock, database)
  }, database)
}

export function listClaims(
  project: string | undefined,
  all = false,
  env: Environment = process.env,
  clock = Date.now(),
  cwd = process.cwd(),
): { claims: ClaimView[] } {
  const actor = claimActor(env)
  const name = claimProject(actor, project, cwd)
  const rows = db()
    .query('SELECT * FROM board_claim WHERE project=? ORDER BY id')
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
  if (!projectByName(project)) throw new Error(`unknown project ${project}; run orch project list`)
  const database = writableDb()
  return writeTransaction(() => {
    const rows = database
      .query(
        "SELECT * FROM board_claim WHERE project=? AND subject_kind='task' AND subject_value=? AND closed_at IS NULL",
      )
      .all(project, key) as ClaimRow[]
    const ids = rows.filter((row) => rowLive(row, clock, database)).map((row) => row.id)
    const close = database.query(
      "UPDATE board_claim SET closed_at=?,close_reason='task-closed' WHERE id=?",
    )
    for (const id of ids) close.run(new Date(clock).toISOString(), id)
    return { released: ids.length }
  }, database)
}

export function stampEndedClaims(clock = Date.now()): number {
  const database = writableDb()
  return writeTransaction(() => {
    const rows = database
      .query('SELECT * FROM board_claim WHERE closed_at IS NULL')
      .all() as ClaimRow[]
    const close = database.query('UPDATE board_claim SET closed_at=?,close_reason=? WHERE id=?')
    let count = 0
    for (const row of rows) {
      const reason = claimCloseReason({
        closed: false,
        lapsesAt: Date.parse(row.lapses_at),
        runStatus: latestRunStatus(row.run_id, database),
        now: clock,
      })
      if (!reason) continue
      close.run(new Date(clock).toISOString(), reason, row.id)
      count++
    }
    return count
  }, database)
}
