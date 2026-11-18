// concern: evidence-exclusion
/** Owns score-time exclusion and restoration of routing evidence. */

import { db, nowIso, writeTransaction } from './database/db.ts'
import { UNJUDGED_EXCLUSION_REASON } from './evidence/unjudged-expiry.ts'
import { isNotEvidenceFailure } from './failure/failure.ts'
import { jobTakesFidelity } from './jobs/job-fidelity.ts'
import { machineId } from './record/machine-identity.ts'
import { closeRunChainQuestions, QUESTION_CLOSE_CHAIN_VOIDED } from './run/question-close.ts'
import {
  adoptRunMutation,
  auditRunMutation,
  authorizeRunMutation,
  reauthorizeRunMutation,
} from './run/run-authority.ts'
import { enqueueRunRecord } from './run/run-outbox.ts'
import { TERMINAL_RUN_STATUS_SQL } from './run/run-status.ts'
import { assertAgentWorkRun } from './run/synthetic-lifecycle-job.ts'
import type { Delivery, Fidelity, Quality } from './score/score.ts'
import { enqueueScoreRecord } from './score/score-outbox.ts'
import { recordScoreVerdict } from './score/score-verdict-record.ts'
import {
  axisOnlyJobFacts,
  refuseChildTurnVoid,
  refuseUnusableThirdVerdictWord,
  refuseUnvoid,
  refuseVerdict,
  VOID_EXCLUSION_REASON,
} from './verdict/verdict-rules.ts'

type JudgmentFlags = {
  has(name: string): boolean
  flag(name: string): string | undefined
}
type ScoreOptions = {
  words: string[]
  note: string | null
  auditReason: string | null
}
type JudgmentPresentation = {
  log(...values: unknown[]): void
}

function voidCannotRecord(failureKind: string | null): string | null {
  if (failureKind === 'unevidenced') return `${failureKind} review`
  if (isNotEvidenceFailure(failureKind)) {
    return `failure kind '${failureKind}' is not evidence`
  }
  return null
}

export function scoredVoidFidelity(
  jobName: string,
  delivery: Delivery,
  quality: Quality | undefined,
  fidelity: Fidelity | undefined,
): Fidelity | undefined {
  const jobNeedsFidelity = jobTakesFidelity(jobName)
  const unusableThirdWord = refuseUnusableThirdVerdictWord(jobName, jobNeedsFidelity, fidelity)
  if (unusableThirdWord) throw new Error(unusableThirdWord.message)
  const needsFidelity = jobNeedsFidelity && delivery !== 'none'
  const refusal = refuseVerdict({
    delivery,
    quality: quality ?? null,
    fidelity: needsFidelity ? (fidelity ?? null) : null,
    job: axisOnlyJobFacts(jobNeedsFidelity),
    failureKind: null,
  })
  if (refusal) throw new Error(refusal.message)
  return needsFidelity ? fidelity : undefined
}

function enqueueTerminalRunRecord(
  id: string,
  evidenceUnvoid: { note: string } | null = null,
): void {
  const row = db()
    .query<{ record_id: string | null; finished_at: string }, [string]>(
      `SELECT record_id, COALESCE(last_event_at, started_at) AS finished_at FROM run
        WHERE record_id=? AND status IN ${TERMINAL_RUN_STATUS_SQL}`,
    )
    .get(id)
  if (row?.record_id) enqueueRunRecord(db(), id, machineId(), row.finished_at, evidenceUnvoid)
}

function clearUnjudgedOwnerExclusion(id: string): boolean {
  return (
    db()
      .query('UPDATE run SET evidence_excluded=NULL WHERE record_id=? AND evidence_excluded=?')
      .run(id, UNJUDGED_EXCLUSION_REASON).changes > 0
  )
}

export function reviveUnjudgedOwnerEvidence(id: string): void {
  if (clearUnjudgedOwnerExclusion(id)) enqueueTerminalRunRecord(id)
}

export type EvidenceExclusion = 'void' | 'blocked-by-tree'

export function requestedEvidenceExclusion(
  flags: JudgmentFlags,
  options: ScoreOptions,
): EvidenceExclusion | null {
  if (flags.has('unvoid')) return null
  if (!flags.has('blocked-by-tree')) return flags.has('void') ? 'void' : null
  if (flags.has('void')) throw new Error('--blocked-by-tree and --void cannot be combined')
  if (!options.note?.trim()) throw new Error('--note is required with --blocked-by-tree')
  if (options.words.length)
    throw new Error('--blocked-by-tree records no delivery or quality verdict')
  return 'blocked-by-tree'
}

export function refuseScoredBlockedByTree(id: string, exclusion: EvidenceExclusion): void {
  if (exclusion !== 'blocked-by-tree') return
  const verdict = db()
    .query<{ delivery: string; quality: string | null }, [string]>(
      'SELECT delivery, quality FROM score WHERE run_record_id=?',
    )
    .get(id)
  if (!verdict) return
  throw new Error(
    `refused: run ${id} already has a verdict (${verdict.delivery} ${verdict.quality}); ` +
      '--blocked-by-tree applies only to an unscored run, because removing a recorded verdict is not supported',
  )
}

export async function recordEvidenceExclusion(
  id: string,
  row: { failure_kind: string | null; job: string; agent?: string },
  exclusion: EvidenceExclusion,
  flags: JudgmentFlags,
  options: ScoreOptions,
  presentation: JudgmentPresentation,
): Promise<void> {
  let authority = authorizeRunMutation(id, 'void')
  const blocked = exclusion === 'blocked-by-tree'
  const delivery = options.words[0] as Delivery | undefined
  const quality = options.words[1] as Quality | undefined
  const fidelity = options.words[2] as Fidelity | undefined
  const pendingStopped = row.agent === '(pending)' && row.failure_kind === 'stopped'
  const cannotRecord = blocked
    ? null
    : pendingStopped
      ? 'stopped before routing'
      : voidCannotRecord(row.failure_kind)
  const scoredFidelity =
    !cannotRecord && delivery ? scoredVoidFidelity(row.job, delivery, quality, fidelity) : undefined
  const excludedReason = blocked
    ? `blocked by its tree: ${options.note!.trim()}`
    : VOID_EXCLUSION_REASON
  const scoredAt = nowIso()
  const recordedBy = flags.flag('scorer') ?? process.env.BOTTEGA_SCORER ?? 'claude'
  const shouldCloseQuestions = writeTransaction(() => {
    authority = reauthorizeRunMutation(authority, 'void')
    authority = adoptRunMutation(authority, 'void')
    db().query('UPDATE run SET evidence_excluded=? WHERE record_id=?').run(excludedReason, id)
    if (!blocked && !cannotRecord && delivery) {
      recordScoreVerdict(
        id,
        delivery,
        quality ?? null,
        scoredFidelity ?? null,
        options.note,
        scoredAt,
        recordedBy,
      )
      enqueueScoreRecord(db(), id, machineId())
    }
    enqueueTerminalRunRecord(id)
    auditRunMutation(authority, 'void', options.auditReason)
    const hasLiveTurn = db()
      .query(
        `SELECT 1 FROM run
          WHERE (record_id=? OR parent_run_record_id=?) AND status IN ('running','asking')
          LIMIT 1`,
      )
      .get(id, id)
    return !blocked && !hasLiveTurn
  })
  if (shouldCloseQuestions) await closeRunChainQuestions(db(), id, QUESTION_CLOSE_CHAIN_VOIDED)
  if (blocked) {
    presentation.log(
      `blocked-by-tree run ${id}: retained run and output; excluded from routing evidence; no verdict recorded`,
    )
    return
  }
  const verdictResult = cannotRecord
    ? `verdict was not recorded: ${cannotRecord}`
    : delivery
      ? `verdict recorded: ${[delivery, quality, scoredFidelity].filter(Boolean).join(' ')}`
      : 'no verdict was provided; existing verdict unchanged'
  presentation.log(
    `voided run ${id}: retained run and output; excluded from routing evidence; ${verdictResult}`,
  )
}

function recordEvidenceUnvoid(
  id: string,
  evidenceExcluded: string | null,
  flags: JudgmentFlags,
  options: ScoreOptions,
  presentation: JudgmentPresentation,
): void {
  if (flags.has('void')) throw new Error('--unvoid and --void cannot be combined')
  if (flags.has('blocked-by-tree')) {
    throw new Error('--unvoid and --blocked-by-tree cannot be combined')
  }
  if (options.words.length) throw new Error('--unvoid cannot be combined with a verdict')
  const note = options.note?.trim()
  if (!note) throw new Error('--note is required with --unvoid')
  const refusal = refuseUnvoid(evidenceExcluded)
  if (refusal) throw new Error(`refused: run ${id} ${refusal}`)
  let authority = authorizeRunMutation(id, 'unvoid')
  writeTransaction(() => {
    authority = adoptRunMutation(authority, 'unvoid')
    db().query('UPDATE run SET evidence_excluded=NULL WHERE record_id=?').run(id)
    enqueueTerminalRunRecord(id, { note })
    auditRunMutation(authority, 'unvoid', note)
  })
  presentation.log(`unvoided run ${id}: routing evidence restored; existing verdict unchanged`)
}

export function recordRequestedUnvoid(
  id: string,
  jobName: string,
  evidenceExcluded: string | null,
  flags: JudgmentFlags,
  options: ScoreOptions,
  presentation: JudgmentPresentation,
): boolean {
  if (!flags.has('unvoid')) return false
  assertAgentWorkRun(id, jobName, 'unvoided')
  recordEvidenceUnvoid(id, evidenceExcluded, flags, options, presentation)
  return true
}

/** Refuses a --void aimed at a child turn before any write; routing reads roots only. */
export function assertVoidTargetsRoot(
  requestedId: string,
  rootId: string,
  voidRequested: boolean,
): void {
  const refusal = refuseChildTurnVoid(requestedId, rootId, voidRequested)
  if (refusal) throw new Error(refusal)
}
