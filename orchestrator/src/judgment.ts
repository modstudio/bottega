// concern: judgment
/** Knows run rows, reviews and findings, score arithmetic, duel persistence, and judgeability. Must not know transports, worktrees, routing, the CLI, durable execution, dispatch, or cleanup. */

import { existsSync, readFileSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { callerIdentityRefusal } from './caller-classification.ts'
import { callerIdentity, db, nowIso, sessionId, writeTransaction } from './database/db.ts'
import {
  assertVoidTargetsRoot,
  recordEvidenceExclusion,
  recordRequestedUnvoid,
  refuseScoredBlockedByTree,
  requestedEvidenceExclusion,
  reviveUnjudgedOwnerEvidence,
} from './evidence-exclusion.ts'
import { isNotEvidenceFailure, pendingAgentVoidAllowed } from './failure/failure.ts'
import { jobTakesFidelity } from './jobs/job-fidelity.ts'
import { JOBS, job } from './jobs/jobs.ts'
import { findingsCloseOutRefusal } from './judgment-closeout-refusal.ts'
import { machineId } from './record/machine-identity.ts'
import { cleanReviewEvidence, parseReviewOutput } from './review/review.ts'
import { type ReviewOutputState, reviewCaptureRefusal } from './review/review-capture-refusal.ts'
import {
  duplicateFindingRefusal,
  type ParsedDuplicateFinding,
  parseDuplicateFinding,
} from './review/review-duplicate-link.ts'
import { enqueueReview, enqueueReviewFinding } from './review/review-outbox.ts'
import {
  assertRunReviewFindingIntegrity,
  completeReview,
  gradeReviewLens,
  type ReviewGrades,
  triageFinding,
} from './review/review-triage.ts'
import {
  type Disposition,
  REVIEW_GRADE_NAMES,
  REVIEW_GRADE_VALUES,
  REVIEW_SEVERITY,
  type ReviewSeverity,
} from './review/review-vocabulary.ts'
import { adoptRunMutation, auditRunMutation, runMutationActor } from './run/run-authority.ts'
import { assertAgentWorkRun } from './run/synthetic-lifecycle-job.ts'
import { pairPartners, parseRunIds, recordDuels, recordLosses, recordTies } from './score/duel.ts'
import { type Delivery, type Fidelity, judgeability, type Quality, weigh } from './score/score.ts'
import {
  type GivenScoreFlags,
  missingScoreRefusal,
  missingScoreRequirements,
  type ScoreRequirementJob,
  workingScoreForm,
} from './score/score-missing.ts'
import { enqueueScoreRecord } from './score/score-outbox.ts'
import { recordScoreVerdict } from './score/score-verdict-record.ts'
import {
  axisOnlyJobFacts,
  refuseUnusableThirdVerdictWord,
  refuseVerdict,
  type VerdictRefusal,
} from './verdict/verdict-rules.ts'

type JudgmentFlags = {
  has(name: string): boolean
  flag(name: string): string | undefined
  values(name: string): string[]
}
type JudgeOptions = {
  words: string[]
  note: string | null
  auditReason: string | null
  notEvidence: readonly string[]
}
type ScoreOptions = JudgeOptions & { dashboardAuthorized: boolean }
const ALL_CLOSE_OUT_FLAGS = ['finding', 'duplicate', ...REVIEW_GRADE_NAMES] as const
type JudgmentPresentation = {
  log(...values: unknown[]): void
  error(...values: unknown[]): void
  pairHint(partner: { id: string; agent: string }): string
}
type JudgeableRun = {
  record_id: string
  agent: string
  job: string
  status: string
  session_id: string | null
  failure_kind: string | null
  output_path: string | null
  repo: string | null
  cwd: string | null
  worktree: string | null
  branch: string | null
  base_commit: string | null
  worktree_source: string | null
}

function requireJudgeableRun(
  requestedId: string,
  row: JudgeableRun | null,
  flags: JudgmentFlags,
): JudgeableRun {
  if (!row) throw new Error(`no run ${requestedId}`)
  const id = row.record_id
  if (['running', 'asking'].includes(row.status)) {
    throw new Error(`run ${id} is ${row.status}, not terminal`)
  }
  if (row.agent === '(pending)')
    throw new Error(`run ${id} cannot be judged: no agent was selected`)
  if (isNotEvidenceFailure(row.failure_kind)) {
    throw new Error(
      `run ${id} cannot be judged: failure kind '${row.failure_kind}' is not evidence`,
    )
  }
  const owner = judgeability(row.session_id, sessionId())
  if (!flags.has('force') && owner.verdict === 'foreign') {
    throw new Error(`run ${id} was made by another session (${owner.owner}); --force overrides`)
  }
  if (!flags.has('force') && owner.verdict === 'anonymous') {
    throw new Error(
      `run ${id} belongs to session ${owner.owner}; ${callerIdentityRefusal(callerIdentity(), 'judge')}; --force overrides`,
    )
  }
  if (!flags.has('force') && owner.verdict === 'unattributed' && !sessionId()) {
    throw new Error(`run ${id} is unowned; ${callerIdentityRefusal(callerIdentity(), 'judge')}`)
  }
  return row
}

function refuseForeignScore(
  id: string,
  owner: ReturnType<typeof judgeability>,
  flags: JudgmentFlags,
  dashboardAuthorized: boolean,
): void {
  if (dashboardAuthorized || flags.has('force')) return
  if (!sessionId() && owner.verdict === 'unattributed') {
    throw new Error(`run ${id} is unowned; ${callerIdentityRefusal(callerIdentity(), 'score')}`)
  }
  if (owner.verdict === 'foreign' || owner.verdict === 'anonymous') {
    throw new Error(
      `run ${id} was made by another session — ownership is not established.\n` +
        `  its session:   ${owner.owner}\n` +
        `  your session:  ${sessionId() ?? callerIdentityRefusal(callerIdentity(), 'score')}\n\n` +
        `Scoring it teaches the router something you cannot know. Ask the session\n` +
        `that ran it to score it — on this machine that is a SendMessage away.\n` +
        `If you are certain (correcting a score you know to be wrong), --force.`,
    )
  }
}

function storedReviewFindings(reviewRecordId: string) {
  return db()
    .query(
      'SELECT ordinal, disposition FROM review_finding WHERE review_record_id=? ORDER BY ordinal',
    )
    .all(reviewRecordId) as { ordinal: number; disposition: string | null }[]
}

function findingForRunReviewOrdinal(
  runId: string,
  ordinal: number,
): {
  record_id: string
  review_record_id: string
  duplicate_of_finding_record_id: string | null
} | null {
  return db()
    .query<
      {
        record_id: string
        review_record_id: string
        duplicate_of_finding_record_id: string | null
      },
      [number, string]
    >(
      `SELECT finding.record_id,finding.review_record_id,finding.duplicate_of_finding_record_id
         FROM review_lens scored_lens
         JOIN review_finding finding
           ON finding.review_record_id=scored_lens.review_record_id AND finding.ordinal=?
         JOIN review_lens finding_lens ON finding_lens.record_id=finding.review_lens_record_id
        WHERE scored_lens.run_record_id=? AND finding_lens.run_record_id=scored_lens.run_record_id`,
    )
    .get(ordinal, runId)
}

function recordDuplicateFindingLink(currentRunId: string, link: ParsedDuplicateFinding): void {
  const current = findingForRunReviewOrdinal(currentRunId, link.ordinal)
  const other = findingForRunReviewOrdinal(link.otherRunId, link.otherOrdinal)
  const runs = db()
    .query<{ record_id: string; job: string; head_commit: string | null }, [string, string]>(
      'SELECT record_id,job,head_commit FROM run WHERE record_id IN (?,?)',
    )
    .all(currentRunId, link.otherRunId)
  const currentRun = runs.find((run) => run.record_id === currentRunId)
  const otherRun = runs.find((run) => run.record_id === link.otherRunId)
  const refusal = duplicateFindingRefusal({
    currentRunId,
    currentFindingId: current?.record_id ?? null,
    currentReviewId: current?.review_record_id ?? null,
    currentTip: currentRun?.head_commit ?? null,
    otherRunId: link.otherRunId,
    otherFindingsJob: Boolean(otherRun && JOBS[otherRun.job]?.findings),
    otherFindingId: other?.record_id ?? null,
    otherReviewId: other?.review_record_id ?? null,
    otherTip: otherRun?.head_commit ?? null,
    currentDuplicateOfFindingId: current?.duplicate_of_finding_record_id ?? null,
  })
  if (refusal) {
    throw new Error(
      `refused --duplicate ${link.ordinal}=${link.otherRunId}#${link.otherOrdinal}: ${refusal}`,
    )
  }
  db()
    .query('UPDATE review_finding SET duplicate_of_finding_record_id=? WHERE record_id=?')
    .run(other!.record_id, current!.record_id)
  enqueueReviewFinding(db(), current!.record_id)
}

function throwIfMissingScore(
  id: string,
  jobRequirements: ScoreRequirementJob,
  given: GivenScoreFlags,
): void {
  const missing = missingScoreRequirements(jobRequirements, given)
  if (missing.length) {
    throw new Error(missingScoreRefusal(id, missing, workingScoreForm(id, jobRequirements, given)))
  }
}

function completeReviewWithoutFindings(reviewRecordId: string, scoredAt: string): void {
  db().query('UPDATE review SET completed_at=? WHERE record_id=?').run(scoredAt, reviewRecordId)
  enqueueReview(db(), reviewRecordId)
}

type ParsedFindingTriage = {
  ordinal: number
  disposition: Disposition
  category: string | undefined
  severity: string | undefined
}

function parseFindingFlags(flags: JudgmentFlags): ParsedFindingTriage[] {
  const findings = flags.values('finding').map((value) => {
    const matched = value.match(/^(\d+)=(accepted|modified|rejected|skipped):(.+)$/)
    if (!matched) {
      throw new Error(
        `bad --finding ${JSON.stringify(value)}; use N=accepted:high or N=rejected:below-bar`,
      )
    }
    const ordinal = Number(matched[1])
    const disposition = matched[2] as Disposition
    const detail = matched[3]!
    if (disposition !== 'rejected' && !REVIEW_SEVERITY.includes(detail as ReviewSeverity)) {
      throw new Error(`finding ${ordinal} severity must be: ${REVIEW_SEVERITY.join(' | ')}`)
    }
    return {
      ordinal,
      disposition,
      category: disposition === 'rejected' ? detail : undefined,
      severity: disposition === 'rejected' ? undefined : detail,
    }
  })
  if (new Set(findings.map((finding) => finding.ordinal)).size !== findings.length) {
    throw new Error('--finding names the same finding more than once')
  }
  return findings
}

function finishReview(
  reviewRecordId: string,
  runId: string,
  findings: ParsedFindingTriage[],
  duplicates: ParsedDuplicateFinding[],
): void {
  for (const finding of findings) {
    triageFinding(
      reviewRecordId,
      finding.ordinal,
      finding.disposition,
      finding.category,
      finding.severity,
    )
  }
  for (const link of duplicates) recordDuplicateFindingLink(runId, link)
  completeReview(reviewRecordId)
}

export async function judgeRun(
  requestedId: string,
  flags: JudgmentFlags,
  options: JudgeOptions,
  presentation: JudgmentPresentation,
) {
  const loaded = db()
    .query(
      `SELECT root.record_id, root.agent, root.job, root.status, root.session_id, root.failure_kind,
          root.output_path, root.repo, root.cwd, root.worktree, root.branch, root.base_commit,
          root.worktree_source
     FROM run requested
     JOIN run root ON root.record_id = COALESCE(requested.parent_run_record_id, requested.record_id)
    WHERE requested.record_id=?`,
    )
    .get(requestedId) as JudgeableRun | null
  const row = requireJudgeableRun(requestedId, loaded, flags)
  const id = row.record_id
  assertAgentWorkRun(id, row.job, 'judged')
  const words = options.words
  const delivery = words[0] as Delivery | undefined
  const quality = words[1] as Quality | undefined
  const fidelity = words[2] as Fidelity | undefined
  const writes = jobTakesFidelity(row.job)
  const axesRefusal = refuseJudgeVerdictAxes(
    presentation,
    row.job,
    row.failure_kind,
    [delivery, quality, fidelity],
    writes,
  )
  if (axesRefusal) throw new Error(axesRefusal.message)
  const findingsJob = Boolean(job(row.job).findings)
  const suppliedGrades = suppliedReviewGrades(flags)
  refuseInvalidReviewGrades(suppliedGrades)
  let parsedOutput: ReturnType<typeof parseReviewOutput> = null
  let reviewRecordId: string | null = null
  let storedGrades: Partial<Record<(typeof REVIEW_GRADE_NAMES)[number], string>> = {}
  let reviewFindings: { ordinal: number; disposition: string | null }[] = []
  if (findingsJob) {
    const lens = db()
      .query(
        'SELECT review_record_id, reproduced, coverage, limits, overlap FROM review_lens WHERE run_record_id=?',
      )
      .get(id) as
      | ({ review_record_id: string } & Record<(typeof REVIEW_GRADE_NAMES)[number], string | null>)
      | null
    reviewRecordId = lens?.review_record_id ?? null
    assertRunReviewFindingIntegrity(id)
    if (delivery !== 'none' && !reviewRecordId) {
      let outputState: ReviewOutputState = 'missing'
      if (row.output_path && existsSync(row.output_path)) {
        outputState = 'invalid'
        parsedOutput = parseReviewOutput(readFileSync(row.output_path, 'utf8'))
      }
      if (!parsedOutput) {
        throw new Error(reviewCaptureRefusal(id, outputState))
      }
    } else if (delivery !== 'none') {
      storedGrades = Object.fromEntries(
        REVIEW_GRADE_NAMES.flatMap((name) => (lens?.[name] ? [[name, lens[name]]] : [])),
      )
      reviewFindings = storedReviewFindings(reviewRecordId!)
    }
  }
  const gradeValues = Object.fromEntries(
    REVIEW_GRADE_NAMES.map((name) => [name, suppliedGrades[name] ?? storedGrades[name]]),
  ) as Record<(typeof REVIEW_GRADE_NAMES)[number], string | undefined>
  const parsedFindings = parseFindingFlags(flags)
  const parsedDuplicates = flags.values('duplicate').map(parseDuplicateFinding)
  if (new Set(parsedDuplicates.map((link) => link.ordinal)).size !== parsedDuplicates.length) {
    throw new Error('--duplicate names the same finding more than once')
  }
  const partners = pairPartners(id, sessionId())
  const comparisonNames = ['better-than', 'worse-than', 'same-as'] as const
  const suppliedComparisons = comparisonNames.filter((name) => flags.flag(name) !== undefined)
  if (suppliedComparisons.length > 1) {
    throw new Error('--better-than, --worse-than, and --same-as are mutually exclusive')
  }
  const comparison = suppliedComparisons[0]
  const comparisonIds = comparison ? parseRunIds(flags.flag(comparison)!, `--${comparison}`) : []
  const requiredFindings: number[] = []
  if (findingsJob && delivery !== 'none') {
    const allowed = reviewRecordId
      ? reviewFindings.map((finding) => finding.ordinal)
      : parsedOutput!.findings.map((_, index) => index + 1)
    const expected = reviewRecordId
      ? reviewFindings
          .filter((finding) => finding.disposition === null)
          .map((finding) => finding.ordinal)
      : allowed
    for (const ordinal of expected) {
      if (!parsedFindings.some((finding) => finding.ordinal === ordinal)) {
        requiredFindings.push(ordinal)
      }
    }
    const unexpected = parsedFindings.find((finding) => !allowed.includes(finding.ordinal))
    if (unexpected) throw new Error(`review for run ${id} has no finding ${unexpected.ordinal}`)
  }
  const closeOutRefusal = closeOutRefusalFor(id, row.job, delivery, flags, ALL_CLOSE_OUT_FLAGS)
  if (closeOutRefusal) throw new Error(closeOutRefusal)
  if (comparison) {
    const expected = partners.map((partner) => partner.record_id).sort((a, b) => a.localeCompare(b))
    const actual = [...comparisonIds].sort((a, b) => a.localeCompare(b))
    if (
      expected.length !== actual.length ||
      expected.some((value, index) => value !== actual[index])
    ) {
      throw new Error(
        `pair verdict must name every comparable partner: ${expected.join(', ') || 'none'}`,
      )
    }
  }
  throwIfMissingScore(
    id,
    { writesRepo: writes, producesFindings: findingsJob },
    givenScoreFlags(delivery, quality, fidelity, gradeValues, {
      requiredFindings,
      findingFlags: flags.values('finding'),
      duplicateFlags: flags.values('duplicate'),
      comparison: comparison ? { name: comparison, value: flags.flag(comparison)! } : undefined,
      requiredComparisonIds: partners.map((partner) => partner.record_id),
    }),
  )
  const note = options.note
  let authority = runMutationActor(id)
  const scoredAt = nowIso()
  const wasScored = Boolean(db().query('SELECT 1 FROM score WHERE run_record_id=?').get(id))
  const scorer = process.env.BOTTEGA_SCORER ?? 'claude'
  const scoredFidelity = writes && delivery !== 'none' ? (fidelity ?? null) : null
  writeTransaction(() => {
    if (!(flags.has('force') && !authority.actor)) authority = adoptRunMutation(authority, 'score')
    if (findingsJob && delivery !== 'none') {
      reviewRecordId = gradeReviewLens(id, parsedOutput, gradeValues as ReviewGrades)
    }
    recordScoreVerdict(id, delivery!, quality ?? null, scoredFidelity, note, scoredAt, scorer)
    reviveUnjudgedOwnerEvidence(id)
    if (reviewRecordId) {
      if (delivery === 'none') {
        completeReviewWithoutFindings(reviewRecordId, scoredAt)
      } else finishReview(reviewRecordId, id, parsedFindings, parsedDuplicates)
    }
    if (comparison === 'better-than')
      recordDuels(id, comparisonIds, sessionId(), scoredAt, flags.has('force'))
    if (comparison === 'worse-than')
      recordLosses(id, comparisonIds, sessionId(), scoredAt, flags.has('force'))
    if (comparison === 'same-as')
      recordTies(id, comparisonIds, sessionId(), scoredAt, flags.has('force'))
    auditRunMutation(authority, wasScored ? 'rescore' : 'score', options.auditReason)
    enqueueScoreRecord(db(), id, machineId())
  })
  presentation.log(
    `judged run ${id}: score${reviewRecordId ? ', completed review' : ''}` +
      `${comparison ? ', pair recorded' : ''}`,
  )
  return { id, row, reviewId: reviewRecordId, comparison }
}

export function refuseJudgeVerdictAxes(
  presentation: JudgmentPresentation,
  jobName: string,
  failureKind: string | null,
  words: readonly [string | undefined, string | undefined, string | undefined],
  writesRepo: boolean,
): VerdictRefusal | null {
  const [delivery, quality, fidelity] = words
  return refuseAxesEarly(presentation, {
    ...filledPresentAxes(delivery, quality, fidelity, writesRepo),
    writesRepo,
    failureKind,
    jobName,
  })
}
/**
 * The axes are judged before the review evidence is gathered, so a mistyped
 * word fails before any work is done.
 */
function refuseAxesEarly(
  presentation: JudgmentPresentation,
  input: {
    delivery: string | undefined
    quality: string | undefined
    fidelity: string | undefined
    writesRepo: boolean
    failureKind: string | null
    jobName: string
    unusedFidelity: boolean
    suppliedFidelity: string | undefined
  },
): VerdictRefusal | null {
  const unusableThirdWord = refuseUnusableThirdVerdictWord(
    input.jobName,
    input.writesRepo,
    input.suppliedFidelity,
  )
  if (unusableThirdWord) return unusableThirdWord
  if (input.unusedFidelity) {
    presentation.error(
      `${input.jobName} has no spec to be faithful to, so it is judged on two axes only`,
    )
  }
  return refuseVerdict({
    delivery: input.delivery ?? '',
    quality: input.quality ?? null,
    fidelity: input.fidelity ?? null,
    job: axisOnlyJobFacts(input.writesRepo),
    failureKind: input.failureKind,
  })
}

/**
 * The CLI teaches the axes where a refusal is the architect reaching for the
 * wrong words; every other refusal already says what to do.
 */
function scoringHelp(
  refusal: VerdictRefusal,
  id: string,
  delivery: string | undefined,
  quality: string | undefined,
  jobName: string,
): string {
  if (refusal.code === 'delivery') {
    return (
      `first word is delivery — did an answer arrive?\n` +
      `  none      nothing usable came back (a vendor error, an empty reply, a denial)\n` +
      `  partial   an answer, but cut off or missing part of the ask\n` +
      `  full      a complete answer\n\n` +
      `then, unless delivery is 'none', quality — was it right?\n` +
      `  wrong     confidently incorrect, or answered a different question\n` +
      `  mixed     some of it right, some not\n` +
      `  right     correct and usable as it stands\n\n` +
      `  ${PLATFORM_SLUG} score ${id} full right --note "..."\n` +
      `  ${PLATFORM_SLUG} score ${id} none --note "..."`
    )
  }
  if (refusal.code === 'fidelity-missing') {
    return (
      `${jobName} writes code, so it needs a third word — fidelity: did it build what\n` +
      `you asked for, or something it decided on instead?\n` +
      `  drifted   solved a different problem, or redesigned as it went\n` +
      `  partial   mostly the spec, with decisions taken that were not its to take\n` +
      `  faithful  built the spec, and ASKED wherever the spec ran out\n\n` +
      `Asking is faithful. A worker that stopped, asked, and built what it was told\n` +
      `did exactly the right thing and must not be marked down for it — read\n` +
      `'${PLATFORM_SLUG} run diff ${id}' against the spec rather than the summary it wrote itself.\n\n` +
      `  ${PLATFORM_SLUG} score ${id} ${delivery} ${quality} faithful --note "..."`
    )
  }
  return refusal.message
}

function refusePendingAgentScore(
  id: string,
  agent: string,
  failureKind: string | null,
  flags: JudgmentFlags,
): void {
  const pendingVoidAllowed = flags.has('void') && pendingAgentVoidAllowed(failureKind)
  if (agent === '(pending)' && !pendingVoidAllowed) {
    throw new Error(`run ${id} cannot be scored: its agent is the placeholder '(pending)'`)
  }
}

function filledPresentAxes(
  delivery: string | undefined,
  quality: string | undefined,
  fidelity: string | undefined,
  writesRepo: boolean,
): {
  delivery: string
  quality: string | undefined
  fidelity: string | undefined
  unusedFidelity: boolean
  suppliedFidelity: string | undefined
} {
  const needsFidelity = writesRepo && delivery !== 'none'
  return {
    delivery: delivery ?? 'full',
    quality: delivery === 'none' ? quality : (quality ?? 'right'),
    fidelity: needsFidelity ? (fidelity ?? 'faithful') : undefined,
    unusedFidelity: !needsFidelity && Boolean(fidelity),
    suppliedFidelity: fidelity,
  }
}

function suppliedReviewGrades(flags: JudgmentFlags): GivenScoreFlags['grades'] {
  return Object.fromEntries(
    REVIEW_GRADE_NAMES.map((name) => [name, flags.flag(name)]),
  ) as GivenScoreFlags['grades']
}

function closeOutRefusalFor(
  id: string,
  jobName: string,
  delivery: string | undefined,
  flags: JudgmentFlags,
  flagNames: readonly ('finding' | 'duplicate' | (typeof REVIEW_GRADE_NAMES)[number])[],
): string | null {
  return findingsCloseOutRefusal({
    runId: id,
    jobName,
    findingsJob: Boolean(job(jobName).findings),
    delivery,
    suppliedFlags: flagNames.filter((name) =>
      name === 'finding' || name === 'duplicate'
        ? flags.values(name).length > 0
        : flags.flag(name) !== undefined,
    ),
  })
}

function givenScoreFlags(
  delivery: string | undefined,
  quality: string | undefined,
  fidelity: string | undefined,
  grades: GivenScoreFlags['grades'],
  closeout: Partial<
    Pick<
      GivenScoreFlags,
      | 'requiredFindings'
      | 'findingFlags'
      | 'duplicateFlags'
      | 'comparison'
      | 'requiredComparisonIds'
    >
  > = {},
): GivenScoreFlags {
  return {
    delivery,
    quality,
    fidelity,
    grades,
    requiredFindings: [],
    findingFlags: [],
    duplicateFlags: [],
    comparison: undefined,
    requiredComparisonIds: [],
    ...closeout,
  }
}

function refuseInvalidReviewGrades(grades: GivenScoreFlags['grades']): void {
  for (const name of REVIEW_GRADE_NAMES) {
    const value = grades[name]
    if (value !== undefined && !(REVIEW_GRADE_VALUES[name] as readonly string[]).includes(value)) {
      throw new Error(`--${name} must be: ${REVIEW_GRADE_VALUES[name].join(' | ')}`)
    }
  }
}

function loadScoreReviewOutput(
  id: string,
  outputPath: string | null,
): { output: ReturnType<typeof parseReviewOutput>; findings: number } {
  const existing = db()
    .query(
      `SELECT rl.record_id, COUNT(rf.record_id) AS findings
       FROM review_lens rl LEFT JOIN review_finding rf ON rf.review_lens_record_id=rl.record_id
      WHERE rl.run_record_id=? GROUP BY rl.record_id`,
    )
    .get(id) as { record_id: string; findings: number } | null
  if (existing) return { output: null, findings: existing.findings }
  if (!outputPath || !existsSync(outputPath)) {
    throw new Error(reviewCaptureRefusal(id, 'missing'))
  }
  const output = parseReviewOutput(readFileSync(outputPath, 'utf8'))
  if (!output) throw new Error(reviewCaptureRefusal(id, 'invalid'))
  const evidence = cleanReviewEvidence(id, output)
  if (evidence.failure) throw new Error(`run ${id} cannot be scored: ${evidence.failure}`)
  return { output, findings: output.findings.length }
}

function defaultEmptyLensGrades(grades: GivenScoreFlags['grades'], findings: number): void {
  if (findings !== 0) return
  grades.reproduced ??= 'none'
  grades.overlap ??= 'none'
  if (grades.reproduced !== 'none' || grades.overlap !== 'none') {
    throw new Error('a lens with findings:[] has --reproduced none and --overlap none')
  }
}

function scoreReviewGrades(
  id: string,
  outputPath: string | null,
  flags: JudgmentFlags,
): { output: ReturnType<typeof parseReviewOutput>; grades: GivenScoreFlags['grades'] } {
  const grades = suppliedReviewGrades(flags)
  const loaded = loadScoreReviewOutput(id, outputPath)
  defaultEmptyLensGrades(grades, loaded.findings)
  refuseInvalidReviewGrades(grades)
  return { output: loaded.output, grades }
}

export async function scoreRun(
  requestedId: string,
  flags: JudgmentFlags,
  options: ScoreOptions,
  presentation: JudgmentPresentation,
): Promise<void> {
  const row = db()
    .query(
      `SELECT root.record_id, root.agent, root.job, root.session_id, root.parent_run_record_id,
          root.failure_kind, root.output_path, root.probe, root.evidence_excluded
     FROM run requested
     JOIN run root ON root.record_id = COALESCE(requested.parent_run_record_id, requested.record_id)
    WHERE requested.record_id = ?`,
    )
    .get(requestedId) as {
    record_id: string
    agent: string
    job: string
    session_id: string | null
    parent_run_record_id: string | null
    failure_kind: string | null
    output_path: string | null
    probe: number
    evidence_excluded: string | null
  } | null
  if (!row) throw new Error(`no run ${requestedId}`)
  const id = row.record_id
  assertVoidTargetsRoot(requestedId, id, flags.has('void'))
  if (recordRequestedUnvoid(id, row.job, row.evidence_excluded, flags, options, presentation))
    return
  // A pick-time harness refusal never selected an agent, but it is still a
  // real failed row the owning session must be able to clear from its ledger.
  // Voiding that one shape records the note without manufacturing evidence.
  refusePendingAgentScore(id, row.agent, row.failure_kind, flags)
  const exclusion = requestedEvidenceExclusion(flags, options)
  if (exclusion) {
    refuseScoredBlockedByTree(id, exclusion)
    await recordEvidenceExclusion(id, row, exclusion, flags, options, presentation)
    return
  }
  assertAgentWorkRun(id, row.job, 'scored')
  const scorer = flags.flag('scorer')
  const dashboardAuthorized = options.dashboardAuthorized
  const note = options.note
  let scoreAuthority = runMutationActor(id)
  const owner = judgeability(row.session_id, sessionId())
  refuseForeignScore(id, owner, flags, dashboardAuthorized)
  const words = options.words
  const delivery = words[0] as Delivery | undefined
  const quality = words[1] as Quality | undefined
  const fidelity = words[2] as Fidelity | undefined
  // A conversation is one unit of work and takes one verdict. Any turn id
  // resolves to the root, which is what routing reads and where the score is
  // recorded.
  // Only the session that read the output may judge it. Enforced here because
  // stating it in AGENTS.md did not hold: see judgeability() for the two
  // sessions that each scored the other's runs inside an hour, both believing
  // the ids were their own.
  // A PERSON scoring from the local dashboard is the gate's one legitimate
  // exception, proven by the dashboard process capability rather than by a
  // caller-controlled scorer label.
  //
  // The gate exists because an AGENT judging a run it did not read teaches
  // the router something false. Someone clicking a verdict has the output on
  // screen. The orchestrator's own dashboard used to bypass this by writing
  // the score table directly, which is the same exception made invisible;
  // `--scorer` records WHO judged it but grants no authority on its own.
  // `bottega score 279 none` and `bottega score 279 full right` are both complete
  // judgments; quality is meaningless without something to judge.
  //
  // Read positionally past the flags, not by index: `bottega score 279 none
  // --note "..."` put `--note` in the quality slot and was rejected as an
  // incoherent judgment, which is a confusing way to be told about a typo
  // you did not make.
  /**
   * A writing job is judged on a third axis, and is REQUIRED to be.
   *
   * Optional, it would go unused: the two-axis habit is years old on this
   * machine and a run that looks complete and correct invites `full right`
   * without further thought — which is precisely the reading that cannot see
   * drift. Demanding the word forces the question to be asked, and the
   * question is the whole point of the axis.
   */
  const writesRepo = jobTakesFidelity(row.job)
  const findingsJob = Boolean(job(row.job).findings)
  assertRunReviewFindingIntegrity(id)
  const needsFidelity = writesRepo && delivery !== 'none'
  const present = filledPresentAxes(delivery, quality, fidelity, writesRepo)
  const initialRefusal = refuseAxesEarly(presentation, {
    ...present,
    writesRepo,
    failureKind: row.failure_kind,
    jobName: row.job,
  })
  if (initialRefusal) throw new Error(scoringHelp(initialRefusal, id, delivery, quality, row.job))
  const gradeFlagRefusal = closeOutRefusalFor(id, row.job, delivery, flags, REVIEW_GRADE_NAMES)
  if (gradeFlagRefusal) throw new Error(gradeFlagRefusal)
  const scoredFidelity = needsFidelity ? fidelity : undefined
  let givenGrades = suppliedReviewGrades(flags)
  let reviewGrade: { output: ReturnType<typeof parseReviewOutput>; grades: ReviewGrades } | null =
    null
  if (findingsJob && delivery !== 'none') {
    const captured = scoreReviewGrades(id, row.output_path, flags)
    givenGrades = captured.grades
    reviewGrade = { output: captured.output, grades: captured.grades as ReviewGrades }
  }
  throwIfMissingScore(
    id,
    { writesRepo, producesFindings: findingsJob },
    givenScoreFlags(delivery, quality, fidelity, givenGrades),
  )
  const scoredDelivery = delivery as Delivery
  const refusal = refuseVerdict({
    delivery: scoredDelivery,
    quality: quality ?? null,
    fidelity: scoredFidelity ?? null,
    job: {
      writesRepo,
      producesFindings: findingsJob,
      hasAnyReviewGrades: reviewGrade !== null,
      hasRequiredReviewGrades: !findingsJob || delivery === 'none' || reviewGrade !== null,
    },
    failureKind: row.failure_kind,
  })
  if (refusal) throw new Error(scoringHelp(refusal, id, scoredDelivery, quality, row.job))
  const comparisonFlags = ['better-than', 'worse-than', 'same-as'] as const
  const suppliedComparisons = comparisonFlags.filter((name) => flags.flag(name) !== undefined)
  if (suppliedComparisons.length > 1) {
    throw new Error('--better-than, --worse-than, and --same-as are mutually exclusive')
  }
  const comparison = suppliedComparisons[0]
  if (comparison) {
    const otherIds = parseRunIds(flags.flag(comparison)!, `--${comparison}`)
    const comparedAt = nowIso()
    if (comparison === 'better-than') {
      recordDuels(id, otherIds, sessionId(), comparedAt, flags.has('force'))
    } else if (comparison === 'worse-than') {
      recordLosses(id, otherIds, sessionId(), comparedAt, flags.has('force'))
    } else {
      recordTies(id, otherIds, sessionId(), comparedAt, flags.has('force'))
    }
  }
  const wasScored = Boolean(db().query('SELECT 1 FROM score WHERE run_record_id=?').get(id))
  const scoredAt = nowIso()
  const recordedBy = scorer ?? process.env.BOTTEGA_SCORER ?? 'claude'
  writeTransaction(() => {
    if (!dashboardAuthorized && !(flags.has('force') && !scoreAuthority.actor)) {
      scoreAuthority = adoptRunMutation(scoreAuthority, 'score')
    }
    if (reviewGrade) gradeReviewLens(id, reviewGrade.output, reviewGrade.grades)
    recordScoreVerdict(
      id,
      scoredDelivery,
      quality ?? null,
      scoredFidelity ?? null,
      note,
      scoredAt,
      recordedBy,
    )
    reviveUnjudgedOwnerEvidence(id)
    auditRunMutation(scoreAuthority, wasScored ? 'rescore' : 'score', options.auditReason)
    enqueueScoreRecord(db(), id, machineId())
  })
  const w = weigh(scoredDelivery, quality ?? null, scoredFidelity ?? null)
  const axes = [delivery, quality, scoredFidelity].filter(Boolean).join(' ')
  presentation.log(`run ${id} (${row.agent}/${row.job}) scored ${axes}  [${w}]`)
  if (!comparison) {
    for (const partner of pairPartners(id, sessionId()))
      presentation.log(presentation.pairHint({ id: partner.record_id, agent: partner.agent }))
  }
}
