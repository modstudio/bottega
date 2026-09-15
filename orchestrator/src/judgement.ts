// concern: judgement
/** Knows run rows, reviews and findings, score arithmetic, duel persistence, and judgeability. Must not know transports, worktrees, routing, the CLI, durable execution, dispatch, or cleanup. */
import { existsSync, readFileSync } from 'node:fs'
import { db, nowIso, sessionId, writeTransaction } from './db.ts'
import { pairPartners, parseRunIds, recordDuels, recordLosses, recordTies } from './duel.ts'
import { JOBS, job } from './jobs.ts'
import { cleanReviewEvidence, parseReviewOutput } from './review.ts'
import {
  completeReview,
  type Disposition,
  gradeReviewLens,
  type ReviewGrades,
  triageFinding,
} from './review-triage.ts'
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
} from './review-vocabulary.ts'
import {
  adoptRunMutation,
  auditRunMutation,
  authorizeRunMutation,
  type RootAuthority,
  runMutationActor,
} from './run-authority.ts'
import {
  DELIVERY,
  type Delivery,
  FIDELITY,
  type Fidelity,
  judgeability,
  QUALITY,
  type Quality,
  weigh,
} from './score.ts'

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
export function judgeRun(
  requestedId: number,
  flags: JudgementFlags,
  options: JudgeOptions,
  presentation: JudgementPresentation,
) {
  const row = db()
    .query(
      `SELECT root.id, root.agent, root.job, root.status, root.session_id, root.failure_kind,
          root.output_path, root.repo, root.cwd, root.worktree, root.branch, root.base_commit,
          root.worktree_source
     FROM run requested
     JOIN run root ON root.id = COALESCE(requested.parent_run_id, requested.id)
    WHERE requested.id=?`,
    )
    .get(requestedId) as {
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
  } | null
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
    if (disposition !== 'rejected' && !REVIEW_SEVERITY.includes(detail as any)) {
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
  writeTransaction(() => {
    if (!(flags.has('force') && !authority.actor)) authority = adoptRunMutation(authority, 'score')
    if (findingsJob && delivery !== 'none') {
      reviewId = gradeReviewLens(id, parsedOutput, gradeValues as ReviewGrades)
    }
    db()
      .query(
        `INSERT INTO score (run_id, delivery, quality, fidelity, note, scored_at, scored_by)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(run_id) DO UPDATE SET delivery=excluded.delivery, quality=excluded.quality,
       fidelity=excluded.fidelity,
       note=CASE
         WHEN score.note IS NULL OR trim(score.note) = '' THEN excluded.note
         WHEN excluded.note IS NULL OR trim(excluded.note) = '' THEN score.note
         ELSE score.note || '\n\n--- re-scored ' || excluded.scored_at || ' ---\n' || excluded.note
       END,
       scored_at=excluded.scored_at`,
      )
      .run(
        id,
        delivery!,
        quality ?? null,
        writes && delivery !== 'none' ? (fidelity ?? null) : null,
        note,
        scoredAt,
        process.env.ORCH_SCORER ?? 'claude',
      )
    if (reviewId) {
      if (delivery === 'none') {
        db().query('UPDATE review SET completed_at=? WHERE id=?').run(scoredAt, reviewId)
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
export function scoreRun(
  requestedId: number,
  flags: JudgementFlags,
  options: ScoreOptions,
  presentation: JudgementPresentation,
): void {
  const row = db()
    .query(
      `SELECT root.id, root.agent, root.job, root.session_id, root.parent_run_id,
          root.failure_kind, root.output_path
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
  } else if (
    !dashboardAuthorized &&
    !flags.has('force') &&
    !sessionId() &&
    owner.verdict === 'unattributed'
  ) {
    throw new Error(`run ${id} is unowned; CLAUDE_CODE_SESSION_ID is not set`)
  } else if (
    (owner.verdict === 'foreign' || owner.verdict === 'anonymous') &&
    !flags.has('force') &&
    !dashboardAuthorized
  ) {
    throw new Error(
      `run ${id} was made by another session — ownership is not established.\n` +
        `  its session:   ${owner.owner}\n` +
        `  your session:  ${sessionId() ?? 'no session identity is present'}\n\n` +
        `Scoring it teaches the router something you cannot know. Ask the session\n` +
        `that ran it to score it — on this machine that is a SendMessage away.\n` +
        `If you are certain (correcting a score you know to be wrong), --force.`,
    )
  }
  const words = options.words
  const delivery = words[0] as Delivery | undefined
  const quality = words[1] as Quality | undefined
  const fidelity = words[2] as Fidelity | undefined
  if (flags.has('void')) {
    const cannotRecord =
      row.failure_kind === 'unevidenced'
        ? `${row.failure_kind} review`
        : row.failure_kind && options.notEvidence.includes(row.failure_kind)
          ? `failure kind '${row.failure_kind}' is not evidence`
          : null
    let scoredFidelity: Fidelity | undefined
    if (!cannotRecord && delivery) {
      if (!DELIVERY.includes(delivery)) {
        throw new Error(`delivery must be one of: ${DELIVERY.join(' | ')}`)
      }
      if (delivery === 'none' && quality) {
        throw new Error("delivery 'none' takes no quality: there was nothing to judge")
      }
      if (delivery !== 'none' && (!quality || !QUALITY.includes(quality))) {
        throw new Error(`delivery '${delivery}' needs a quality: ${QUALITY.join(' | ')}`)
      }
      const needsFidelity = Boolean(JOBS[row.job]?.needs.writesRepo) && delivery !== 'none'
      if (needsFidelity && (!fidelity || !FIDELITY.includes(fidelity))) {
        throw new Error(`${row.job} writes code, so verdicts require a fidelity axis`)
      }
      scoredFidelity = needsFidelity ? fidelity : undefined
    }
    const scoredAt = nowIso()
    writeTransaction(() => {
      voidAuthority = adoptRunMutation(voidAuthority!, 'void')
      db()
        .query('UPDATE run SET evidence_excluded=? WHERE id=?')
        .run('voided with orch score --void', id)
      if (!cannotRecord && delivery) {
        recordScoreVerdict(
          id,
          delivery,
          quality ?? null,
          scoredFidelity ?? null,
          note,
          scoredAt,
          scorer ?? process.env.ORCH_SCORER ?? 'claude',
        )
      }
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
  if (row.failure_kind === 'unevidenced') {
    throw new Error(`run ${id} cannot be scored: ${row.failure_kind} review`)
  }
  if (row.failure_kind && options.notEvidence.includes(row.failure_kind)) {
    throw new Error(
      `run ${id} cannot be scored: failure kind '${row.failure_kind}' is not evidence`,
    )
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
  const needsFidelity = Boolean(JOBS[row.job]?.needs.writesRepo) && delivery !== 'none'
  if (!delivery || !DELIVERY.includes(delivery)) {
    throw new Error(
      `first word is delivery — did an answer arrive?\n` +
        `  none      nothing usable came back (a vendor error, an empty reply, a denial)\n` +
        `  partial   an answer, but cut off or missing part of the ask\n` +
        `  full      a complete answer\n\n` +
        `then, unless delivery is 'none', quality — was it right?\n` +
        `  wrong     confidently incorrect, or answered a different question\n` +
        `  mixed     some of it right, some not\n` +
        `  right     correct and usable as it stands\n\n` +
        `  orch score ${id} full right --note "..."\n` +
        `  orch score ${id} none --note "..."`,
    )
  }
  if (delivery === 'none' && quality) {
    throw new Error("delivery 'none' takes no quality: there was nothing to judge")
  }
  if (delivery !== 'none' && (!quality || !QUALITY.includes(quality))) {
    throw new Error(`delivery '${delivery}' needs a quality: ${QUALITY.join(' | ')}`)
  }
  const reviewGradeFlags = ['reproduced', 'coverage', 'limits', 'overlap'] as const
  const suppliedReviewGradeFlags = reviewGradeFlags.filter((name) => flags.flag(name) !== undefined)
  const findingsJob = Boolean(job(row.job).findings)
  if (suppliedReviewGradeFlags.length && !findingsJob) {
    throw new Error(
      `${row.job} is not a findings-producing lens; review grade flags are not valid for this job`,
    )
  }
  if (suppliedReviewGradeFlags.length && delivery === 'none') {
    throw new Error("delivery 'none' takes no review grades: there was no lens output to judge")
  }
  if (needsFidelity && (!fidelity || !FIDELITY.includes(fidelity))) {
    throw new Error(
      `${row.job} writes code, so it needs a third word — fidelity: did it build what\n` +
        `you asked for, or something it decided on instead?\n` +
        `  drifted   solved a different problem, or redesigned as it went\n` +
        `  partial   mostly the spec, with decisions taken that were not its to take\n` +
        `  faithful  built the spec, and ASKED wherever the spec ran out\n\n` +
        `Asking is faithful. A worker that stopped, asked, and built what it was told\n` +
        `did exactly the right thing and must not be marked down for it — read\n` +
        `'orch diff ${id}' against the spec rather than the summary it wrote itself.\n\n` +
        `  orch score ${id} ${delivery} ${quality} faithful --note "..."`,
    )
  }
  if (!needsFidelity && fidelity) {
    presentation.error(`${row.job} has no spec to be faithful to, so it is judged on two axes only`)
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
  writeTransaction(() => {
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
      scorer ?? process.env.ORCH_SCORER ?? 'claude',
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
