// concern: record-board-claims
/** Owns hosted board claims. Must not know HTTP or local stores. */

import type { SQL } from 'bun'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  BOARD_CLAIM_DEFAULT_MS,
  type ClaimCloseReason,
  type ClaimSubject,
  claimCloseReason,
  claimDurationRefusal,
  claimIsLive,
  claimNote,
  claimSubjectsConflict,
  claimTakeDecision,
  parseClaimSubject,
} from '../board/board-claim-policy.ts'
import { requireRealSession } from '../board/board-policy.ts'
import {
  asBoardError,
  type HostedBoardClaim,
  type HostedBoardPostInput,
  type HostedBoardTakeClaimInput,
  RecordBoardError,
} from './record-board-contract.ts'
import {
  postHostedBoardNoticeInTransaction,
  requireOwnedHostedRunAndMachine,
  resolveVisibleProjectId,
} from './record-board-messages.ts'
import { hostedBoardActor } from './record-board-scope.ts'
import { type BoardTenant, withBoardTenant } from './record-board-tx.ts'

const iso = (value: unknown) => (value == null ? null : new Date(String(value)).toISOString())

export const CLAIM_CONFLICT = 'claim conflicts with:'

type ClaimRow = Record<string, unknown>

function hostedLive(row: ClaimRow, clock: number): boolean {
  return claimIsLive({
    closed: row.closed_at != null,
    lapsesAt: Date.parse(String(row.lapses_at)),
    runStatus: null,
    now: clock,
  })
}

async function previousIds(tx: SQL, id: string): Promise<string[]> {
  const rows = await tx`
    SELECT id FROM board_claim WHERE superseded_by_claim_id=${id}::uuid ORDER BY taken_at, id
  `
  return (rows as { id: unknown }[]).map((row) => String(row.id))
}

async function claimView(
  tx: SQL,
  row: ClaimRow,
  clock: number,
  projectName: string,
): Promise<HostedBoardClaim> {
  return {
    id: String(row.id),
    project: projectName,
    subject: {
      kind: String(row.subject_kind) as ClaimSubject['kind'],
      value: String(row.subject_value),
    },
    holder: String(row.holder_user_id),
    note: row.note == null ? null : String(row.note),
    runId: row.run_id == null ? null : String(row.run_id),
    takenAt: iso(row.taken_at)!,
    renewedAt: iso(row.renewed_at)!,
    lapsesAt: iso(row.lapses_at)!,
    live: hostedLive(row, clock),
    closedAt: iso(row.closed_at),
    closeReason: row.close_reason == null ? null : String(row.close_reason),
    previousClaimIds: await previousIds(tx, String(row.id)),
    supersededByClaimId:
      row.superseded_by_claim_id == null ? null : String(row.superseded_by_claim_id),
  }
}

async function loadClaim(tx: SQL, id: string): Promise<ClaimRow | null> {
  const rows = await tx`SELECT * FROM board_claim WHERE id=${id}::uuid`
  return rows[0] ? (rows[0] as ClaimRow) : null
}

async function projectNameById(tx: SQL, projectId: string): Promise<string> {
  const rows = await tx`SELECT name FROM project WHERE id=${projectId}::uuid`
  if (!rows[0]) throw new RecordBoardError(`unknown or invisible board project ${projectId}`, 400)
  return String(rows[0].name)
}

function sessionOrNull(value: string | null | undefined): string | null {
  const actor = hostedBoardActor(value)
  if (actor.kind === 'architect')
    asBoardError(() => requireRealSession(actor.session, 'hosted board claim'))
  return actor.session
}

async function tellHolder(
  tx: SQL,
  input: {
    userId: string
    projectId: string
    projectName: string
    claimId: string
    holderUserId: string
    holderSession: string | null
    title: string
    body: string
    authorSession: string | null
    clock: number
  },
): Promise<void> {
  if (!input.holderSession) return
  const notice: HostedBoardPostInput & { userId: string } = {
    id: newRecordId(),
    kind: 'notice',
    audience: `session:${input.holderSession}`,
    title: input.title,
    body: input.body,
    expiresAt: new Date(input.clock + 24 * 60 * 60 * 1000).toISOString(),
    authorSession: input.authorSession,
    userId: input.userId,
  }
  const posted = await postHostedBoardNoticeInTransaction(tx, notice, input.clock, {
    scopeProjectIds: [input.projectId],
    recipientUserIds: [input.holderUserId],
    claimId: input.claimId,
  })
  void posted
}

function takeOverlaps(
  open: ClaimRow[],
  subject: ClaimSubject,
  userId: string,
  clock: number,
): { exactHeld: ClaimRow | undefined; conflicts: ClaimRow[]; foreignLive: ClaimRow[] } {
  const overlaps = open.filter((row) =>
    claimSubjectsConflict(subject, {
      kind: String(row.subject_kind) as ClaimSubject['kind'],
      value: String(row.subject_value),
    }),
  )
  const exactHeld = overlaps.find(
    (row) =>
      hostedLive(row, clock) &&
      String(row.subject_kind) === subject.kind &&
      String(row.subject_value) === subject.value &&
      String(row.holder_user_id) === userId,
  )
  const conflicts = overlaps.filter((row) => String(row.holder_user_id) !== userId)
  return { exactHeld, conflicts, foreignLive: conflicts.filter((row) => hostedLive(row, clock)) }
}

type ClaimTellKind = 'taken-over' | 'conflict-attempt'

function claimTellNotice(
  kind: ClaimTellKind,
  input: { userId: string; subject: string; project: string; claimId: string },
): { title: string; body: string } {
  if (kind === 'taken-over') {
    return {
      title: 'Claim taken over',
      body: `User ${input.userId} took over claim ${input.claimId} with ${input.subject} in ${input.project}.`,
    }
  }
  return {
    title: 'Conflicting claim attempt',
    body: `User ${input.userId} attempted to claim ${input.subject} in ${input.project}; it conflicts with claim ${input.claimId}.`,
  }
}

async function tellConflicts(
  tx: SQL,
  conflicts: ClaimRow[],
  input: BoardTenant & HostedBoardTakeClaimInput,
  projectId: string,
  session: string | null,
  clock: number,
  kind: ClaimTellKind,
): Promise<void> {
  for (const conflict of conflicts) {
    const copy = claimTellNotice(kind, {
      userId: input.userId,
      subject: input.subject,
      project: input.project,
      claimId: String(conflict.id),
    })
    await tellHolder(tx, {
      userId: input.userId,
      projectId,
      projectName: input.project,
      claimId: String(conflict.id),
      holderUserId: String(conflict.holder_user_id),
      holderSession: conflict.holder_session == null ? null : String(conflict.holder_session),
      title: copy.title,
      body: copy.body,
      authorSession: session,
      clock,
    })
  }
}

async function supersedeConflicts(
  tx: SQL,
  conflicts: ClaimRow[],
  input: BoardTenant & HostedBoardTakeClaimInput,
  projectId: string,
  session: string | null,
  clock: number,
  now: string,
): Promise<void> {
  for (const conflict of conflicts) {
    const ended =
      claimCloseReason({
        closed: false,
        lapsesAt: Date.parse(String(conflict.lapses_at)),
        runStatus: null,
        now: clock,
      }) ?? 'taken-over'
    await tx`
      UPDATE board_claim
      SET closed_at=${now}::timestamptz,
          close_reason=${ended},
          superseded_by_claim_id=${input.id}::uuid
      WHERE id=${String(conflict.id)}::uuid
    `
  }
  await tellConflicts(tx, conflicts, input, projectId, session, clock, 'taken-over')
}

function differentRenewalTerms(
  row: ClaimRow,
  input: HostedBoardTakeClaimInput,
  duration: number,
  note: string | null | undefined,
): boolean {
  return (
    (input.durationMs !== undefined && Number(row.duration_ms) !== duration) ||
    (input.runId !== undefined && String(row.run_id ?? '') !== String(input.runId ?? '')) ||
    (note !== undefined && (row.note == null ? null : String(row.note)) !== note)
  )
}

type TakenClaim = HostedBoardClaim & { action: 'taken' | 'renewed' | 'taken-over' }
type TakeOutcome = TakenClaim | { refused: string }

function takeRefused(outcome: TakeOutcome): outcome is { refused: string } {
  return 'refused' in outcome
}

export async function takeHostedBoardClaim(
  input: BoardTenant & HostedBoardTakeClaimInput,
): Promise<TakenClaim> {
  const subject = asBoardError(() => parseClaimSubject(input.subject))
  const note = asBoardError(() => claimNote(input.note))
  const duration = input.durationMs ?? BOARD_CLAIM_DEFAULT_MS
  const durationRefusal = claimDurationRefusal(duration)
  if (durationRefusal) throw new RecordBoardError(durationRefusal, 400)
  const session = sessionOrNull(input.holderSession)
  const clock = Date.now()
  const outcome = await withBoardTenant(input, true, (tx) =>
    takeClaimInTx(tx, input, subject, note, duration, session, clock),
  )
  if (takeRefused(outcome)) throw new RecordBoardError(outcome.refused, 409)
  return outcome
}

async function replayExistingTake(
  tx: SQL,
  input: BoardTenant & HostedBoardTakeClaimInput,
  existing: ClaimRow,
  subject: ClaimSubject,
  clock: number,
): Promise<HostedBoardClaim & { action: 'taken' | 'renewed' | 'taken-over' }> {
  const name = await projectNameById(tx, String(existing.project_id))
  const sameSubject =
    String(existing.subject_kind) === subject.kind &&
    String(existing.subject_value) === subject.value &&
    String(existing.holder_user_id) === input.userId
  if (!sameSubject) {
    throw new RecordBoardError(
      `board claim ${input.id} already exists with different content; mint a new id`,
      409,
    )
  }
  return {
    ...(await claimView(tx, existing, clock, name)),
    action: hostedLive(existing, clock) ? 'renewed' : 'taken',
  }
}

async function renewOpenClaim(
  tx: SQL,
  input: BoardTenant & HostedBoardTakeClaimInput,
  exactHeld: ClaimRow,
  duration: number,
  note: string | null | undefined,
  clock: number,
): Promise<HostedBoardClaim & { action: 'renewed' }> {
  if (differentRenewalTerms(exactHeld, input, duration, note)) {
    throw new RecordBoardError(
      `claim ${String(exactHeld.id)} already holds this subject with different terms; release it and take it again`,
      409,
    )
  }
  const renewedAt = new Date(clock).toISOString()
  await tx`
    UPDATE board_claim
    SET renewed_at=${renewedAt}::timestamptz,
        lapses_at=${new Date(clock + Number(exactHeld.duration_ms)).toISOString()}::timestamptz
    WHERE id=${String(exactHeld.id)}::uuid
  `
  const row = await loadClaim(tx, String(exactHeld.id))
  return { ...(await claimView(tx, row!, clock, input.project)), action: 'renewed' }
}

async function insertTakenClaim(
  tx: SQL,
  input: BoardTenant & HostedBoardTakeClaimInput,
  subject: ClaimSubject,
  note: string | null | undefined,
  duration: number,
  session: string | null,
  projectId: string,
  conflicts: ClaimRow[],
  clock: number,
): Promise<HostedBoardClaim & { action: 'taken' | 'taken-over' }> {
  const now = new Date(clock).toISOString()
  await requireOwnedHostedRunAndMachine(tx, input.userId, {
    runId: input.runId,
    runField: 'runId',
  })
  await supersedeConflicts(tx, conflicts, input, projectId, session, clock, now)
  await tx`
    INSERT INTO board_claim (
      id, project_id, subject_kind, subject_value, holder_user_id, holder_session, note, run_id,
      duration_ms, taken_at, renewed_at, lapses_at
    ) VALUES (
      ${input.id}::uuid, ${projectId}::uuid, ${subject.kind}, ${subject.value},
      ${input.userId}::uuid, ${session}, ${note ?? null}, ${input.runId ?? null}::uuid,
      ${duration}, ${now}::timestamptz, ${now}::timestamptz,
      ${new Date(clock + duration).toISOString()}::timestamptz
    )
  `
  const row = await loadClaim(tx, input.id)
  return {
    ...(await claimView(tx, row!, clock, input.project)),
    action: conflicts.length ? 'taken-over' : 'taken',
  }
}

async function takeClaimInTx(
  tx: SQL,
  input: BoardTenant & HostedBoardTakeClaimInput,
  subject: ClaimSubject,
  note: string | null | undefined,
  duration: number,
  session: string | null,
  clock: number,
): Promise<TakeOutcome> {
  const existing = await loadClaim(tx, input.id)
  if (existing) return replayExistingTake(tx, input, existing, subject, clock)
  const projectId = await resolveVisibleProjectId(tx, input.project)
  const open = (await tx`
    SELECT * FROM board_claim WHERE project_id=${projectId}::uuid AND closed_at IS NULL
    ORDER BY taken_at, id
  `) as ClaimRow[]
  const { exactHeld, conflicts, foreignLive } = takeOverlaps(open, subject, input.userId, clock)
  const decision = claimTakeDecision({
    sameHolderSameSubject: exactHeld !== undefined,
    conflictingClaim: conflicts.length > 0,
    foreignLiveConflict: foreignLive.length > 0,
    force: false,
    actorKind: 'architect',
  })
  if (decision === 'renew' && exactHeld)
    return renewOpenClaim(tx, input, exactHeld, duration, note, clock)
  if (decision === 'refuse') {
    await tellConflicts(tx, foreignLive, input, projectId, session, clock, 'conflict-attempt')
    return {
      refused: `${CLAIM_CONFLICT} ${foreignLive.map((conflict) => `user ${String(conflict.holder_user_id)} until ${iso(conflict.lapses_at)}`).join('; ')}`,
    }
  }
  return insertTakenClaim(
    tx,
    input,
    subject,
    note,
    duration,
    session,
    projectId,
    decision === 'take-over' ? conflicts : [],
    clock,
  )
}

export async function renewHostedBoardClaim(
  input: BoardTenant & { id: string; holderSession?: string | null },
): Promise<HostedBoardClaim> {
  sessionOrNull(input.holderSession)
  const clock = Date.now()
  return withBoardTenant(input, false, async (tx) => {
    const row = await loadClaim(tx, input.id)
    if (!row) throw new RecordBoardError(`no board claim ${input.id}`, 404)
    if (!hostedLive(row, clock)) {
      throw new RecordBoardError(`claim ${input.id} is no longer live; take the subject again`, 400)
    }
    if (String(row.holder_user_id) !== input.userId) {
      throw new RecordBoardError(`only the claim holder may renew claim ${input.id}`, 403)
    }
    const at = new Date(clock).toISOString()
    await tx`
      UPDATE board_claim
      SET renewed_at=${at}::timestamptz,
          lapses_at=${new Date(clock + Number(row.duration_ms)).toISOString()}::timestamptz
      WHERE id=${input.id}::uuid
    `
    const name = await projectNameById(tx, String(row.project_id))
    return claimView(tx, (await loadClaim(tx, input.id))!, clock, name)
  })
}

export async function releaseHostedBoardClaim(
  input: BoardTenant & { id: string; holderSession?: string | null },
): Promise<HostedBoardClaim> {
  sessionOrNull(input.holderSession)
  const clock = Date.now()
  return withBoardTenant(input, false, async (tx) => {
    const row = await loadClaim(tx, input.id)
    if (!row) throw new RecordBoardError(`no board claim ${input.id}`, 404)
    if (!hostedLive(row, clock))
      throw new RecordBoardError(`claim ${input.id} is no longer live`, 400)
    if (String(row.holder_user_id) !== input.userId) {
      throw new RecordBoardError(`only the claim holder may release claim ${input.id}`, 403)
    }
    await tx`
      UPDATE board_claim
      SET closed_at=${new Date(clock).toISOString()}::timestamptz, close_reason=${'released' satisfies ClaimCloseReason}
      WHERE id=${input.id}::uuid
    `
    const name = await projectNameById(tx, String(row.project_id))
    return claimView(tx, (await loadClaim(tx, input.id))!, clock, name)
  })
}

export async function listHostedBoardClaims(
  input: BoardTenant & { project: string },
): Promise<{ claims: HostedBoardClaim[] }> {
  const clock = Date.now()
  return withBoardTenant(input, false, async (tx) => {
    const projectId = await resolveVisibleProjectId(tx, input.project)
    const rows = (await tx`
      SELECT * FROM board_claim WHERE project_id=${projectId}::uuid ORDER BY taken_at, id
    `) as ClaimRow[]
    const claims = []
    for (const row of rows) claims.push(await claimView(tx, row, clock, input.project))
    return { claims }
  })
}

export async function releaseHostedBoardTaskClaims(
  input: BoardTenant & { project: string; key: string },
): Promise<{ released: number }> {
  if (!input.key.trim()) throw new RecordBoardError('task key is required', 400)
  const clock = Date.now()
  return withBoardTenant(input, false, async (tx) => {
    const projectId = await resolveVisibleProjectId(tx, input.project)
    const rows = (await tx`
      SELECT * FROM board_claim
      WHERE project_id=${projectId}::uuid AND subject_kind=${'task'} AND subject_value=${input.key}
        AND closed_at IS NULL
    `) as ClaimRow[]
    const foreignLive = rows.filter(
      (row) => String(row.holder_user_id) !== input.userId && hostedLive(row, clock),
    )
    if (foreignLive.length) {
      throw new RecordBoardError(
        `${CLAIM_CONFLICT} ${foreignLive.map((row) => `user ${String(row.holder_user_id)} until ${iso(row.lapses_at)}`).join('; ')}`,
        409,
      )
    }
    const closable = rows.filter(
      (row) => String(row.holder_user_id) === input.userId || !hostedLive(row, clock),
    )
    const at = new Date(clock).toISOString()
    for (const row of closable) {
      await tx`
        UPDATE board_claim
        SET closed_at=${at}::timestamptz, close_reason=${'task-closed' satisfies ClaimCloseReason}
        WHERE id=${String(row.id)}::uuid
      `
    }
    return { released: closable.length }
  })
}
