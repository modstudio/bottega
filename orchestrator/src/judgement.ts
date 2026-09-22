// concern: judgement
/** Knows run rows, reviews and findings, score arithmetic, duel persistence, and judgeability. Must not know transports, worktrees, routing, the CLI, durable execution, dispatch, or cleanup. */
import { existsSync, readFileSync } from 'node:fs'
import { newRecordId } from '../../shared/record/schema.ts'
import { db, nowIso, sessionId, writeTransaction } from './database/db.ts'
import { JOBS, job } from './jobs/jobs.ts'
import { machineId } from './record/machine-identity.ts'
import { recordApiClient } from './record/record-api-client.ts'
import { cleanReviewEvidence, parseReviewOutput } from './review/review.ts'
import { enqueueReview } from './review/review-outbox.ts'
import {
  completeReview,
  type Disposition,
  gradeReviewLens,
  type ReviewGrades,
  triageFinding,
} from './review/review-triage.ts'
import {
  REVIEW_COVERAGE,
  REVIEW_LIMITS,
  REVIEW_OVERLAP,
  REVIEW_REPRODUCED,
  REVIEW_SEVERITY,
  type ReviewCoverage,
  type ReviewLimits,
  type ReviewOverlap,
  type ReviewReproduced,
  type ReviewSeverity,
} from './review/review-vocabulary.ts'
import {
  adoptRunMutation,
  auditRunMutation,
  authorizeRunMutation,
  type RootAuthority,
  runMutationActor,
} from './run/run-authority.ts'
import { enqueueRunRecord } from './run/run-outbox.ts'
import { pairPartners, parseRunIds, recordDuels, recordLosses, recordTies } from './score/duel.ts'
import {
  DELIVERY,
  type Delivery,
  FIDELITY,
  type Fidelity,
  judgeability,
  QUALITY,
  type Quality,
  weigh,
} from './score/score.ts'
import { refuseVerdict } from './verdict/verdict-rules.ts'

type JudgementFlags = {
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
type JudgementPresentation = {
  log(...values: unknown[]): void
  error(...values: unknown[]): void
  pairHint(partner: { id: number; agent: string }): string
}
function recordScoreVerdict(
  id: number,
  delivery: Delivery,
  quality: Quality | null,
  fidelity: Fidelity | null,
  note: string | null,
  scoredAt: string,
  scorer: string,
): void {
  db()
    .query(
      `INSERT INTO score (run_id, delivery, quality, fidelity, note, scored_at, scored_by)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(run_id) DO UPDATE SET delivery=excluded.delivery, quality=excluded.quality,
                                       fidelity=excluded.fidelity,
                                       note=CASE
                                         WHEN score.note IS NULL OR trim(score.note) = ''
                                           THEN excluded.note
                                         WHEN excluded.note IS NULL OR trim(excluded.note) = ''
                                           THEN score.note
                                         ELSE score.note || '\\n\\n--- re-scored ' ||
                                           excluded.scored_at || ' ---\\n' || excluded.note
                                       END,
                                       scored_at=excluded.scored_at`,
    )
    .run(id, delivery, quality, fidelity, note, scoredAt, scorer)
}

function hostedRunId(id: number): string {
  const row = db()
    .query<{ record_id: string | null }, [number]>('SELECT record_id FROM run WHERE id=?')
    .get(id)
  if (!row) throw new Error(`no run ${id}`)
  return row.record_id ?? newRecordId()
}

function persistHostedRunId(id: number, recordId: string): void {
  db().query('UPDATE run SET record_id=? WHERE id=?').run(recordId, id)
}

async function pushHostedScore(
  recordId: string,
  delivery: Delivery,
  quality: Quality | null,
  fidelity: Fidelity | null,
  note: string | null,
  scoredAt: string,
  scorer: string,
): Promise<void> {
  await recordApiClient().putScore(recordId, {
    delivery,
    quality,
    fidelity,
    note,
    scoredAt,
    scoredBy: scorer,
  })
}

async function pushHostedVoid(recordId: string, reason: string): Promise<void> {
  await recordApiClient().voidRun(recordId, { reason })
}

type JudgeableRun = {
  id: number
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
  requestedId: number,
  row: JudgeableRun | null,
  flags: JudgementFlags,
  options: JudgeOptions,
): JudgeableRun {
  if (!row) throw new Error(`no run ${requestedId}`)
  const id = row.id
  if (['running', 'asking'].includes(row.status)) {
    throw new Error(`run ${id} is ${row.status}, not terminal`)
  }
  if (row.agent === '(pending)')
    throw new Error(`run ${id} cannot be judged: no agent was selected`)
  if (
    row.failure_kind === 'unevidenced' ||
    (row.failure_kind && options.notEvidence.includes(row.failure_kind))
  ) {
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
      `run ${id} belongs to session ${owner.owner}, but no session identity is present; --force overrides`,
    )
  }
  if (!flags.has('force') && owner.verdict === 'unattributed' && !sessionId()) {
    throw new Error(`run ${id} is unowned; CLAUDE_CODE_SESSION_ID is not set`)
  }
  return row
}

function refuseForeignScore(
  id: number,
  owner: ReturnType<typeof judgeability>,
  flags: JudgementFlags,
  dashboardAuthorized: boolean,
): void {
  if (dashboardAuthorized || flags.has('force')) return
  if (!sessionId() && owner.verdict === 'unattributed') {
    throw new Error(`run ${id} is unowned; CLAUDE_CODE_SESSION_ID is not set`)
  }
  if (owner.verdict === 'foreign' || owner.verdict === 'anonymous') {
    throw new Error(
      `run ${id} was made by another session — ownership is not established.\n` +
        `  its session:   ${owner.owner}\n` +
        `  your session:  ${sessionId() ?? 'no session identity is present'}\n\n` +
        `Scoring it teaches the router something you cannot know. Ask the session\n` +
        `that ran it to score it — on this machine that is a SendMessage away.\n` +
        `If you are certain (correcting a score you know to be wrong), --force.`,
    )
  }
}

function voidCannotRecord(
  failureKind: string | null,
  notEvidence: readonly string[],
): string | null {
  if (failureKind === 'unevidenced') return `${failureKind} review`
  if (failureKind && notEvidence.includes(failureKind)) {
    return `failure kind '${failureKind}' is not evidence`
  }
  return null
}

function scoredVoidFidelity(
  jobName: string,
  delivery: Delivery,
  quality: Quality | undefined,
  fidelity: Fidelity | undefined,
): Fidelity | undefined {
  if (!DELIVERY.includes(delivery)) {
    throw new Error(`delivery must be one of: ${DELIVERY.join(' | ')}`)
  }
  if (delivery === 'none' && quality) {
    throw new Error("delivery 'none' takes no quality: there was nothing to judge")
  }
  if (delivery !== 'none' && (!quality || !QUALITY.includes(quality))) {
    throw new Error(`delivery '${delivery}' needs a quality: ${QUALITY.join(' | ')}`)
  }
  const needsFidelity = Boolean(JOBS[jobName]?.needs.writesRepo) && delivery !== 'none'
  if (needsFidelity && (!fidelity || !FIDELITY.includes(fidelity))) {
    throw new Error(`${jobName} writes code, so verdicts require a fidelity axis`)
  }
  return needsFidelity ? fidelity : undefined
}

function enqueueVoidedRunRecord(id: number): void {
  const row = db()
    .query<{ record_id: string | null; finished_at: string }, [number]>(
      `SELECT record_id, COALESCE(last_event_at, started_at) AS finished_at FROM run
        WHERE id=? AND status IN ('ok','failed','stale','stopped')`,
    )
    .get(id)
  if (row?.record_id) enqueueRunRecord(db(), id, machineId(), row.finished_at)
}
export async function judgeRun(
  requestedId: number,
  flags: JudgementFlags,
  options: JudgeOptions,
  presentation: JudgementPresentation,
) {
  const loaded = db()
    .query(
      `SELECT root.id, root.agent, root.job, root.status, root.session_id, root.failure_kind,
          root.output_path, root.repo, root.cwd, root.worktree, root.branch, root.base_commit,
          root.worktree_source
     FROM run requested
     JOIN run root ON root.id = COALESCE(requested.parent_run_id, requested.id)
    WHERE requested.id=?`,
    )
    .get(requestedId) as JudgeableRun | null
  const row = requireJudgeableRun(requestedId, loaded, flags, options)
  const id = row.id
  const words = options.words
  const delivery = words[0] as Delivery | undefined
  const quality = words[1] as Quality | undefined
  const fidelity = words[2] as Fidelity | undefined
  const missing: string[] = []
  if (!delivery) missing.push(`<${DELIVERY.join('|')}>`)
  else if (!DELIVERY.includes(delivery)) {
    throw new Error(`delivery must be: ${DELIVERY.join(' | ')}`)
  }
  if (delivery === 'none' && quality) throw new Error("delivery 'none' takes no quality")
  if (delivery !== 'none' && !quality) missing.push(`<${QUALITY.join('|')}>`)
  else if (quality && !QUALITY.includes(quality)) {
    throw new Error(`quality must be: ${QUALITY.join(' | ')}`)
  }
  const writes = Boolean(JOBS[row.job]?.needs.writesRepo)
  if (writes && delivery !== 'none' && !fidelity) missing.push(`<${FIDELITY.join('|')}>`)
  else if (fidelity && !FIDELITY.includes(fidelity)) {
    throw new Error(`fidelity must be: ${FIDELITY.join(' | ')}`)
  }
  if (!writes && fidelity) throw new Error(`${row.job} is judged on two axes only`)
  const findingsJob = Boolean(job(row.job).findings)
  const gradeNames = ['reproduced', 'coverage', 'limits', 'overlap'] as const
  const suppliedGrades = {
    reproduced: flags.flag('reproduced'),
    coverage: flags.flag('coverage'),
    limits: flags.flag('limits'),
    overlap: flags.flag('overlap'),
  }
  const validGrades = {
    reproduced: REVIEW_REPRODUCED,
    coverage: REVIEW_COVERAGE,
    limits: REVIEW_LIMITS,
    overlap: REVIEW_OVERLAP,
  } as const
  for (const name of gradeNames) {
    const value = suppliedGrades[name]
    if (value !== undefined && !(validGrades[name] as readonly string[]).includes(value)) {
      throw new Error(`--${name} must be: ${validGrades[name].join(' | ')}`)
    }
  }
  let parsedOutput: ReturnType<typeof parseReviewOutput> = null
  let reviewId: number | null = null
  let storedGrades: Partial<Record<(typeof gradeNames)[number], string>> = {}
  let reviewFindings: { ordinal: number; disposition: string | null }[] = []
  if (findingsJob) {
    const lens = db()
      .query(
        'SELECT review_id, reproduced, coverage, limits, overlap FROM review_lens WHERE run_id=?',
      )
      .get(id) as
      | ({ review_id: number } & Record<(typeof gradeNames)[number], string | null>)
      | null
    reviewId = lens?.review_id ?? null
    if (delivery !== 'none' && !reviewId) {
      if (row.output_path && existsSync(row.output_path)) {
        parsedOutput = parseReviewOutput(readFileSync(row.output_path, 'utf8'))
      }
      if (!parsedOutput)
        throw new Error(
          `run ${id} has no recorded review; recover it with orch review record ${id}`,
        )
    } else if (delivery !== 'none') {
      storedGrades = Object.fromEntries(
        gradeNames.flatMap((name) => (lens?.[name] ? [[name, lens[name]]] : [])),
      )
      reviewFindings = db()
        .query('SELECT ordinal, disposition FROM review_finding WHERE review_id=? ORDER BY ordinal')
        .all(reviewId) as { ordinal: number; disposition: string | null }[]
    }
  }
  const gradeValues = Object.fromEntries(
    gradeNames.map((name) => [name, suppliedGrades[name] ?? storedGrades[name]]),
  ) as Record<(typeof gradeNames)[number], string | undefined>
  const parsedFindings = flags.values('finding').map((value) => {
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
  if (new Set(parsedFindings.map((finding) => finding.ordinal)).size !== parsedFindings.length) {
    throw new Error('--finding names the same finding more than once')
  }
  const partners = pairPartners(id, sessionId())
  const comparisonNames = ['better-than', 'worse-than', 'same-as'] as const
  const suppliedComparisons = comparisonNames.filter((name) => flags.flag(name) !== undefined)
  if (suppliedComparisons.length > 1) {
    throw new Error('--better-than, --worse-than, and --same-as are mutually exclusive')
  }
  const comparison = suppliedComparisons[0]
  const comparisonIds = comparison ? parseRunIds(flags.flag(comparison)!, `--${comparison}`) : []
  if (findingsJob && delivery !== 'none') {
    for (const name of gradeNames) if (!gradeValues[name]) missing.push(`--${name}`)
    const allowed = reviewId
      ? reviewFindings.map((finding) => finding.ordinal)
      : parsedOutput!.findings.map((_, index) => index + 1)
    const expected = reviewId
      ? reviewFindings
          .filter((finding) => finding.disposition === null)
          .map((finding) => finding.ordinal)
      : allowed
    for (const ordinal of expected) {
      if (!parsedFindings.some((finding) => finding.ordinal === ordinal)) {
        missing.push(`--finding ${ordinal}=<disposition>:<severity-or-category>`)
      }
    }
    const unexpected = parsedFindings.find((finding) => !allowed.includes(finding.ordinal))
    if (unexpected) throw new Error(`review for run ${id} has no finding ${unexpected.ordinal}`)
  } else if (parsedFindings.length || gradeNames.some((name) => suppliedGrades[name])) {
    throw new Error(`${row.job} does not take findings close-out flags`)
  }
  if (partners.length && !comparison) {
    missing.push(
      `--better-than ${partners.map((partner) => partner.id).join(',')} | ` +
        `--worse-than ${partners.map((partner) => partner.id).join(',')} | ` +
        `--same-as ${partners.map((partner) => partner.id).join(',')}`,
    )
  }
  if (comparison) {
    const expected = partners.map((partner) => partner.id).sort((a, b) => a - b)
    const actual = [...comparisonIds].sort((a, b) => a - b)
    if (
      expected.length !== actual.length ||
      expected.some((value, index) => value !== actual[index])
    ) {
      throw new Error(
        `pair verdict must name every comparable partner: ${expected.join(', ') || 'none'}`,
      )
    }
  }
  if (missing.length) {
    throw new Error(
      `orch judge ${id} is missing:\n${missing.map((item) => `  ${item}`).join('\n')}`,
    )
  }
  const note = options.note
  let authority = runMutationActor(id)
  const scoredAt = nowIso()
  const wasScored = Boolean(db().query('SELECT 1 FROM score WHERE run_id=?').get(id))
  const scorer = process.env.ORCH_SCORER ?? 'claude'
  const scoredFidelity = writes && delivery !== 'none' ? (fidelity ?? null) : null
  const recordId = hostedRunId(id)
  await pushHostedScore(
    recordId,
    delivery!,
    quality ?? null,
    scoredFidelity,
    note,
    scoredAt,
    scorer,
  )
  writeTransaction(() => {
    persistHostedRunId(id, recordId)
    if (!(flags.has('force') && !authority.actor)) authority = adoptRunMutation(authority, 'score')
    if (findingsJob && delivery !== 'none') {
      reviewId = gradeReviewLens(id, parsedOutput, gradeValues as ReviewGrades)
    }
    recordScoreVerdict(id, delivery!, quality ?? null, scoredFidelity, note, scoredAt, scorer)
    if (reviewId) {
      if (delivery === 'none') {
        db().query('UPDATE review SET completed_at=? WHERE id=?').run(scoredAt, reviewId)
        enqueueReview(db(), reviewId)
      } else {
        for (const finding of parsedFindings) {
          triageFinding(
            reviewId,
            finding.ordinal,
            finding.disposition,
            finding.category,
            finding.severity,
          )
        }
        completeReview(reviewId)
      }
    }
    if (comparison === 'better-than')
      recordDuels(id, comparisonIds, sessionId(), scoredAt, flags.has('force'))
    if (comparison === 'worse-than')
      recordLosses(id, comparisonIds, sessionId(), scoredAt, flags.has('force'))
    if (comparison === 'same-as')
      recordTies(id, comparisonIds, sessionId(), scoredAt, flags.has('force'))
    auditRunMutation(authority, wasScored ? 'rescore' : 'score', options.auditReason)
  })
  presentation.log(
    `judged run ${id}: score${reviewId ? `, completed review ${reviewId}` : ''}` +
      `${comparison ? ', pair recorded' : ''}`,
  )
  return { id, row, reviewId, comparison }
}
export async function scoreRun(
  requestedId: number,
  flags: JudgementFlags,
  options: ScoreOptions,
  presentation: JudgementPresentation,
): Promise<void> {
  const row = db()
    .query(
      `SELECT root.id, root.agent, root.job, root.session_id, root.parent_run_id,
          root.failure_kind, root.output_path, root.probe
     FROM run requested
     JOIN run root ON root.id = COALESCE(requested.parent_run_id, requested.id)
    WHERE requested.id = ?`,
    )
    .get(requestedId) as {
    id: number
    agent: string
    job: string
    session_id: string | null
    parent_run_id: number | null
    failure_kind: string | null
    output_path: string | null
    probe: number
  } | null
  if (!row) throw new Error(`no run ${requestedId}`)
  const id = row.id
  // A pick-time harness refusal never selected an agent, but it is still a
  // real failed row the owning session must be able to clear from its ledger.
  // Voiding that one shape records the note without manufacturing evidence.
  if (row.agent === '(pending)' && !(flags.has('void') && row.failure_kind === 'harness')) {
    throw new Error(`run ${id} cannot be scored: its agent is the placeholder '(pending)'`)
  }
  const scorer = flags.flag('scorer')
  const dashboardAuthorized = options.dashboardAuthorized
  const note = options.note
  let scoreAuthority = runMutationActor(id)
  const owner = judgeability(row.session_id, sessionId())
  let voidAuthority: RootAuthority | null = null
  if (flags.has('void')) {
    voidAuthority = authorizeRunMutation(id, 'void')
  } else {
    refuseForeignScore(id, owner, flags, dashboardAuthorized)
  }
  const words = options.words
  const delivery = words[0] as Delivery | undefined
  const quality = words[1] as Quality | undefined
  const fidelity = words[2] as Fidelity | undefined
  if (flags.has('void')) {
    const cannotRecord = voidCannotRecord(row.failure_kind, options.notEvidence)
    const scoredFidelity =
      !cannotRecord && delivery
        ? scoredVoidFidelity(row.job, delivery, quality, fidelity)
        : undefined
    const scoredAt = nowIso()
    const voidReason = 'voided with orch score --void'
    const recordId = hostedRunId(id)
    const recordedBy = scorer ?? process.env.ORCH_SCORER ?? 'claude'
    await pushHostedVoid(recordId, voidReason)
    if (!cannotRecord && delivery) {
      await pushHostedScore(
        recordId,
        delivery,
        quality ?? null,
        scoredFidelity ?? null,
        note,
        scoredAt,
        recordedBy,
      )
    }
    writeTransaction(() => {
      persistHostedRunId(id, recordId)
      voidAuthority = adoptRunMutation(voidAuthority!, 'void')
      db().query('UPDATE run SET evidence_excluded=? WHERE id=?').run(voidReason, id)
      if (!cannotRecord && delivery) {
        recordScoreVerdict(
          id,
          delivery,
          quality ?? null,
          scoredFidelity ?? null,
          note,
          scoredAt,
          recordedBy,
        )
      }
      enqueueVoidedRunRecord(id)
      auditRunMutation(voidAuthority!, 'void', options.auditReason)
    })
    const verdictResult = cannotRecord
      ? `verdict was not recorded: ${cannotRecord}`
      : delivery
        ? `verdict recorded: ${[delivery, quality, scoredFidelity].filter(Boolean).join(' ')}`
        : 'no verdict was provided; existing verdict unchanged'
    presentation.log(
      `voided run ${id}: retained run and output; excluded from routing evidence; ${verdictResult}`,
    )
    return
  }
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
  // `orch score 279 none` and `orch score 279 full right` are both complete
  // judgements; quality is meaningless without something to judge.
  //
  // Read positionally past the flags, not by index: `orch score 279 none
  // --note "..."` put `--note` in the quality slot and was rejected as an
  // incoherent judgement, which is a confusing way to be told about a typo
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
  const writesRepo = Boolean(JOBS[row.job]?.needs.writesRepo)
  const findingsJob = Boolean(job(row.job).findings)
  const initialRefusal = refuseVerdict({
    delivery: delivery ?? '',
    quality: quality ?? null,
    fidelity: fidelity ?? null,
    writesRepo,
    producesFindings: false,
    hasRequiredReviewGrades: true,
    failureKind: row.failure_kind,
    probe: Boolean(row.probe),
  })
  if (initialRefusal) throw new Error(initialRefusal)
  const needsFidelity = writesRepo && delivery !== 'none'
  const reviewGradeFlags = ['reproduced', 'coverage', 'limits', 'overlap'] as const
  const suppliedReviewGradeFlags = reviewGradeFlags.filter((name) => flags.flag(name) !== undefined)
  if (suppliedReviewGradeFlags.length && !findingsJob) {
    throw new Error(
      `${row.job} is not a findings-producing lens; review grade flags are not valid for this job`,
    )
  }
  if (suppliedReviewGradeFlags.length && delivery === 'none') {
    throw new Error("delivery 'none' takes no review grades: there was no lens output to judge")
  }
  const scoredFidelity = needsFidelity ? fidelity : undefined
  let reviewGrade: { output: ReturnType<typeof parseReviewOutput>; grades: ReviewGrades } | null =
    null
  if (findingsJob && delivery !== 'none') {
    const existing = db()
      .query(
        `SELECT rl.id, COUNT(rf.id) AS findings
       FROM review_lens rl LEFT JOIN review_finding rf ON rf.review_lens_id=rl.id
      WHERE rl.run_id=? GROUP BY rl.id`,
      )
      .get(id) as { id: number; findings: number } | null
    let output: ReturnType<typeof parseReviewOutput> = null
    if (!existing) {
      if (!row.output_path || !existsSync(row.output_path)) {
        throw new Error(`run ${id} has no recorded output to capture as a review`)
      }
      output = parseReviewOutput(readFileSync(row.output_path, 'utf8'))
      if (!output) throw new Error(`run ${id} output does not satisfy the review contract`)
      const evidence = cleanReviewEvidence(id, output)
      if (evidence.failure) {
        throw new Error(`run ${id} cannot be scored: ${evidence.failure}`)
      }
    }
    const findings = existing?.findings ?? output!.findings.length
    const raw: Record<keyof ReviewGrades, string | undefined> = {
      reproduced: flags.flag('reproduced'),
      coverage: flags.flag('coverage'),
      limits: flags.flag('limits'),
      overlap: flags.flag('overlap'),
    }
    if (findings === 0) {
      raw.reproduced ??= 'none'
      raw.overlap ??= 'none'
      if (raw.reproduced !== 'none' || raw.overlap !== 'none') {
        throw new Error('a lens with findings:[] has --reproduced none and --overlap none')
      }
    }
    const valid =
      raw.reproduced &&
      REVIEW_REPRODUCED.includes(raw.reproduced as ReviewReproduced) &&
      raw.coverage &&
      REVIEW_COVERAGE.includes(raw.coverage as ReviewCoverage) &&
      raw.limits &&
      REVIEW_LIMITS.includes(raw.limits as ReviewLimits) &&
      raw.overlap &&
      REVIEW_OVERLAP.includes(raw.overlap as ReviewOverlap)
    if (!valid) {
      throw new Error(
        `${row.job} grading requires architect review fields:\n` +
          `  --reproduced ${REVIEW_REPRODUCED.join(' | ')}\n` +
          `  --coverage   ${REVIEW_COVERAGE.join(' | ')}\n` +
          `  --limits     ${REVIEW_LIMITS.join(' | ')}\n` +
          `  --overlap    ${REVIEW_OVERLAP.join(' | ')}`,
      )
    }
    reviewGrade = { output, grades: raw as ReviewGrades }
  }
  const refusal = refuseVerdict({
    delivery: delivery!,
    quality: quality ?? null,
    fidelity: scoredFidelity ?? null,
    writesRepo,
    producesFindings: findingsJob,
    hasRequiredReviewGrades: !findingsJob || delivery === 'none' || reviewGrade !== null,
    failureKind: row.failure_kind,
    probe: Boolean(row.probe),
  })
  if (refusal) throw new Error(refusal)
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
  const wasScored = Boolean(db().query('SELECT 1 FROM score WHERE run_id=?').get(id))
  const scoredAt = nowIso()
  const recordedBy = scorer ?? process.env.ORCH_SCORER ?? 'claude'
  const recordId = hostedRunId(id)
  await pushHostedScore(
    recordId,
    delivery,
    quality ?? null,
    scoredFidelity ?? null,
    note,
    scoredAt,
    recordedBy,
  )
  writeTransaction(() => {
    persistHostedRunId(id, recordId)
    if (!dashboardAuthorized && !(flags.has('force') && !scoreAuthority.actor)) {
      scoreAuthority = adoptRunMutation(scoreAuthority, 'score')
    }
    if (reviewGrade) gradeReviewLens(id, reviewGrade.output, reviewGrade.grades)
    recordScoreVerdict(
      id,
      delivery,
      quality ?? null,
      scoredFidelity ?? null,
      note,
      scoredAt,
      recordedBy,
    )
    auditRunMutation(scoreAuthority, wasScored ? 'rescore' : 'score', options.auditReason)
  })
  const w = weigh(delivery, quality ?? null, scoredFidelity ?? null)
  const axes = [delivery, quality, scoredFidelity].filter(Boolean).join(' ')
  presentation.log(`run ${id} (${row.agent}/${row.job}) scored ${axes}  [${w}]`)
  if (!comparison) {
    for (const partner of pairPartners(id, sessionId()))
      presentation.log(presentation.pairHint(partner))
  }
}
