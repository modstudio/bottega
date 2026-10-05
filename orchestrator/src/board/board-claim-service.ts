import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { db, writableDb, writeTransaction } from '../database/db.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import {
  BOARD_CLAIM_DEFAULT_MS,
  BOARD_CLAIM_MAX_MS,
  BOARD_CLAIM_RESOURCE_MAX_CHARS,
  type ClaimActor,
  type ClaimCloseReason,
  claimCloseReason,
  claimIsLive,
  type ClaimSubject,
  claimSubjectsConflict,
  claimTakeDecision,
  mayForceClaim,
  mayReleaseClaim,
  mayRenewClaim,
  sameClaimHolder,
} from './board-claim-policy.ts'
import { BOARD_BODY_MAX_CHARS } from './board-policy.ts'
import { postNoticeInTransaction } from './board-service.ts'
import { boardActor, type Environment } from './board-store.ts'
import { pathTagRefusal } from './board-tags.ts'

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
  previous_claim_id: number | null
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
  previousClaimId: number | null
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

function parseSubject(expression: string): ClaimSubject {
  const match = /^(task|path|resource):(.*)$/.exec(expression)
  if (!match)
    throw new Error(`invalid claim subject ${expression}; use task:<KEY>, path:<glob>, or resource:<name>`)
  const kind = match[1] as ClaimSubject['kind']
  const value = match[2]!.trim()
  if (!value) throw new Error(`claim ${kind} subject is empty; provide a value after ${kind}:`)
  if (kind === 'path') {
    const refusal = pathTagRefusal(value)
    if (refusal) throw new Error(refusal)
  }
  if (kind === 'resource') {
    if (value.length > BOARD_CLAIM_RESOURCE_MAX_CHARS)
      throw new Error(
        `claim resource exceeds ${BOARD_CLAIM_RESOURCE_MAX_CHARS} characters; shorten it`,
      )
    if (containsSecretShaped(value))
      throw new Error('claim resource contains secret-shaped text; remove the credential and retry')
  }
  return { kind, value }
}

function claimNote(note: string | undefined): string | null | undefined {
  if (note === undefined) return undefined
  const value = note.trim()
  if (!value) return null
  if (value.length > BOARD_BODY_MAX_CHARS)
    throw new Error(`claim note exceeds ${BOARD_BODY_MAX_CHARS} characters; shorten it`)
  if (containsSecretShaped(value))
    throw new Error('claim note contains secret-shaped text; remove the credential and retry')
  return value
}

function claimProject(actor: ClaimActor, requested: string | undefined, cwd: string): string {
  if (actor.kind === 'operator') {
    if (!requested) throw new Error('operator claim requires --project <name>')
    if (!projectByName(requested)) throw new Error(`unknown project ${requested}; run orch project list`)
    return requested
  }
  const held = projectAt(cwd)
  if (!held) throw new Error(`claim project is unknown for ${cwd}; run from a registered project`)
  if (requested && requested !== held.name)
    throw new Error(`architect session belongs to project ${held.name}; omit --project or use ${held.name}`)
  return held.name
}

function holder(row: ClaimRow): ClaimActor {
  return row.holder_kind === 'operator'
    ? { kind: 'operator', session: null }
    : { kind: 'architect', session: row.holder_session! }
}

function latestRunStatus(runId: number | null, database = db()): string | null {
  if (runId === null) return null
  const row = database
    .query(
      `SELECT latest.status FROM run member
       JOIN run latest ON latest.id=(
         SELECT id FROM run
         WHERE id=COALESCE(member.parent_run_id,member.id)
            OR parent_run_id=COALESCE(member.parent_run_id,member.id)
         ORDER BY turn DESC,id DESC LIMIT 1)
       WHERE member.id=?`,
    )
    .get(runId) as { status: string } | null
  return row?.status ?? 'missing'
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
    previousClaimId: row.previous_claim_id,
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
  const notice = postNoticeInTransaction({ audience, title, body }, env, clock, cwd, database)
  database.query('UPDATE board_message SET claim_id=? WHERE id=?').run(claimId, notice.id)
}

export function takeClaim(
  input: TakeClaimInput,
  env: Environment = process.env,
  clock = Date.now(),
  cwd = process.cwd(),
): TakeClaimResult {
  const actor = claimActor(env)
  if (input.force && !mayForceClaim(actor)) throw new Error('only the operator may use --force')
  const subject = parseSubject(input.subject)
  const note = claimNote(input.note)
  const duration = input.durationMs ?? BOARD_CLAIM_DEFAULT_MS
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > BOARD_CLAIM_MAX_MS)
    throw new Error(`claim duration must be positive and at most ${BOARD_CLAIM_MAX_MS}ms`)
  const project = claimProject(actor, input.project, cwd)
  const database = writableDb()
  validateRunTie(input.runId, actor, database)
  const outcome = writeTransaction(() => {
    const candidates = database
      .query('SELECT * FROM board_claim WHERE project=? AND closed_at IS NULL ORDER BY id')
      .all(project) as ClaimRow[]
    const conflict = candidates.find((row) =>
      claimSubjectsConflict(subject, { kind: row.subject_kind, value: row.subject_value }),
    )
    const conflictLive = conflict ? rowLive(conflict, clock, database) : false
    const exactHeld = Boolean(
      conflict &&
        conflict.subject_kind === subject.kind &&
        conflict.subject_value === subject.value &&
        sameClaimHolder(actor, holder(conflict)),
    )
    const decision = claimTakeDecision({
      sameHolderSameSubject: exactHeld,
      conflictingClaim: Boolean(conflict),
      conflictingLive: conflictLive,
      force: Boolean(input.force),
      actorKind: actor.kind,
    })
    const now = new Date(clock).toISOString()
    if (decision === 'renew') {
      if (
        (input.durationMs !== undefined && input.durationMs !== conflict!.duration_ms) ||
        (input.runId !== undefined && input.runId !== conflict!.run_id) ||
        (note !== undefined && note !== conflict!.note)
      )
        throw new Error(
          `claim ${conflict!.id} already holds this subject with different terms; release it and take it again`,
        )
      const lapses = new Date(clock + conflict!.duration_ms).toISOString()
      database
        .query('UPDATE board_claim SET renewed_at=?,lapses_at=? WHERE id=?')
        .run(now, lapses, conflict!.id)
      return { row: claimById(conflict!.id, database), action: 'renewed' as const, refusal: null }
    }
    if (decision === 'refuse') {
      if (conflict!.holder_kind === 'architect')
        linkClaimNotice(
          conflict!.id,
          `session:${conflict!.holder_session}`,
          'Conflicting claim attempt',
          `${actor.kind === 'operator' ? 'The operator' : `Session ${actor.session}`} attempted to claim ${input.subject} in ${project}.`,
          env,
          clock,
          cwd,
          database,
        )
      const ask =
        conflict!.holder_kind === 'architect'
          ? `ask the holder with orch board ask --audience session:${conflict!.holder_session}, or wait`
          : 'wait for the operator claim to lapse'
      return {
        row: conflict!,
        action: null,
        refusal: `claim conflicts with ${conflict!.holder_kind === 'operator' ? 'operator' : `session ${conflict!.holder_session}`} until ${conflict!.lapses_at}; ${ask}`,
      }
    }
    if (conflict) {
      database
        .query("UPDATE board_claim SET closed_at=?,close_reason='taken-over' WHERE id=?")
        .run(now, conflict.id)
    }
    const lapses = new Date(clock + duration).toISOString()
    const inserted = database
      .query(
        `INSERT INTO board_claim
         (project,subject_kind,subject_value,holder_kind,holder_session,note,run_id,duration_ms,
          taken_at,renewed_at,lapses_at,closed_at,close_reason,previous_claim_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)`,
      )
      .run(
        project,
        subject.kind,
        subject.value,
        actor.kind,
        actor.session,
        note ?? null,
        input.runId ?? null,
        duration,
        now,
        now,
        lapses,
        conflict?.id ?? null,
      )
    const row = claimById(Number(inserted.lastInsertRowid), database)
    if (conflict?.holder_kind === 'architect')
      linkClaimNotice(
        conflict.id,
        `session:${conflict.holder_session}`,
        'Claim taken over',
        `${actor.kind === 'operator' ? 'The operator' : `Session ${actor.session}`} took over ${input.subject} in ${project}.`,
        env,
        clock,
        cwd,
        database,
      )
    return {
      row,
      action: conflict ? ('taken-over' as const) : ('taken' as const),
      refusal: null,
    }
  }, database)
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
    if (!mayRenewClaim(actor, holder(row))) throw new Error(`only the claim holder may renew claim ${id}`)
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
  const rows = db().query('SELECT * FROM board_claim WHERE project=? ORDER BY id').all(name) as ClaimRow[]
  const claims = rows.map((row) => view(row, clock)).filter((row) => all || row.live)
  return { claims }
}

export function releaseTaskClaims(
  key: string,
  project: string,
  env: Environment = process.env,
  clock = Date.now(),
): { released: number } {
  const actor = claimActor(env)
  if (actor.kind !== 'operator')
    throw new Error('release-task is an operator integration verb; run it outside an architect session')
  if (!projectByName(project)) throw new Error(`unknown project ${project}; run orch project list`)
  const database = writableDb()
  return writeTransaction(() => {
    const rows = database
      .query("SELECT * FROM board_claim WHERE project=? AND subject_kind='task' AND subject_value=? AND closed_at IS NULL")
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
    const rows = database.query('SELECT * FROM board_claim WHERE closed_at IS NULL').all() as ClaimRow[]
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
