// concern: pull-request-admission
/** Resolves the caller's exact change, applies triage policy, and records admission evidence. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { type Project, projectAt } from '../project/projects.ts'
import { enqueueLandingOverride, enqueueLandingTriageSnapshot } from '../record/landing-outbox.ts'
import type { ApplicableReview, ReviewFunnelPlan } from '../review/review-applicability.ts'
import {
  branchRunOwnerSession,
  type ChangeGroup,
  measureChangeGroup,
  reviewsForTriage,
  serializePathSet,
  type TriageReviewRow,
} from '../review/review-group.ts'
import { reviewLineage } from '../review/review-lineage-store.ts'
import { gatherPostFixReviewFacts, postFixReviewDecision } from '../review/review-post-fix.ts'
import {
  currentReviewRoundIdentity,
  type ReviewRoundBudgetDecision,
  reviewBudgetForBranch,
  reviewRoundBudgetDecision,
} from '../review/review-round-budget.ts'
import { budgetedRoundApplicabilityForChange } from '../review/review-round-lens-service.ts'
import { reviewRemoteTrunkRefExists, reviewTrunkRef } from '../review/review-target.ts'
import {
  type AdmissionDecision,
  type AdmissionOverride,
  decideAdmission,
} from './admission-decision.ts'
import { decideTriageOverride, type TriageOverrideAttribution } from './override-decision.ts'
import { decidePrePush, destinationBranch } from './pre-push-decision.ts'
import {
  ceilingTriageFacts,
  decideTriage,
  type TriageDecision,
  type TriageReviewGroup,
} from './triage-decision.ts'

type Git = (cwd: string, args: string[]) => string

export type PullRequestChange = {
  project: Project
  branch: string
  tip: string
  tree: string
  group: ChangeGroup
  tier: 0 | 1 | 2 | 3
  applicability: ApplicableReview
  reviewPlan?: ReviewFunnelPlan
}

const command = (cwd: string, argv: string[], label: string): string => {
  const process = Bun.spawnSync(argv, {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (process.exitCode !== 0) {
    throw new Error(
      `${label} failed: ${process.stderr.toString().trim() || `exit ${process.exitCode}`}`,
    )
  }
  return process.stdout.toString().trim()
}

const git: Git = (cwd, args) => command(cwd, ['git', ...args], `git ${args.join(' ')}`)

export function resolvePullRequestChange(
  cwd: string,
  sha = 'HEAD',
  database: Database = db(),
  runGit: Git = git,
  branchOverride?: string,
): PullRequestChange {
  const project = projectAt(cwd, database)
  if (!project)
    throw new Error(
      `cannot resolve a project for ${cwd}; run ${PLATFORM_SLUG} pr from a registered checkout`,
    )
  const branch = branchOverride ?? runGit(cwd, ['branch', '--show-current'])
  if (!branch)
    throw new Error(`${PLATFORM_SLUG} pr requires a checked-out branch, not detached HEAD`)
  const tip = runGit(cwd, ['rev-parse', '--verify', `${sha}^{commit}`])
  const tree = runGit(cwd, ['rev-parse', '--verify', `${tip}^{tree}`])
  const measured = measureChangeGroup(cwd, project, branch, tip)
  if (!measured) throw new Error(`could not measure the change group for ${branch} at ${tip}`)
  const trunk = project.settings.trunk!.trim()
  const remoteTrackingRefExists = reviewRemoteTrunkRefExists(
    trunk,
    (args) =>
      Bun.spawnSync(['git', ...args], {
        cwd,
        env: targetGitEnvironment(cwd),
        stdout: 'pipe',
        stderr: 'pipe',
      }).exitCode === 0,
  )
  const postFix = postFixReviewDecision({
    facts: gatherPostFixReviewFacts({
      database,
      repo: cwd,
      to: tip,
      trunkRef: reviewTrunkRef(remoteTrackingRefExists, trunk),
      project: project.name,
      branch,
    }),
    tier: measured.tier.tier,
    review: project.settings.review,
  })
  const { reviewPlan } = budgetedRoundApplicabilityForChange({
    database,
    group: measured.group,
    relevant: measured.applicability,
    postFix,
    review: project.settings.review,
    tier: measured.tier.tier,
  })
  return {
    project,
    branch,
    tip,
    tree,
    group: measured.group,
    tier: measured.tier.tier,
    applicability: measured.applicability,
    reviewPlan,
  }
}

function triageDecision(change: PullRequestChange, database: Database): TriageDecision {
  const reviews = reviewsForTriage(database, change.group)
  const lineage = reviewLineage(database, change.project.name, change.branch)
  const grouped = new Map<string, TriageReviewRow[]>()
  for (const review of reviews.branchReviews) {
    if (review.patchId === null || review.pathSet === null) continue
    const key = JSON.stringify([review.patchId, review.pathSet])
    const group = grouped.get(key) ?? []
    group.push(review)
    grouped.set(key, group)
  }
  const branchReviewGroups: TriageReviewGroup[] = [...grouped.values()].map((reviews) => ({
    reviews,
  }))
  return decideTriage({
    patchId: change.group.patchId,
    pathSet: serializePathSet(change.group.pathSet),
    tip: change.tip,
    tier: change.tier,
    applicableReview: change.applicability,
    reviewPlan: change.reviewPlan,
    branchOwnerSession: branchRunOwnerSession(database, change.project.name, change.branch),
    reviews: reviews.reviews,
    branchReviewGroups,
    reads: database
      .query<
        {
          record_id: string
          tip: string
          patch_id: string
          path_set: string
          recorded_at: string
          session_id: string | null
        },
        string[]
      >(
        `SELECT record_id,tip,patch_id,path_set,recorded_at,session_id FROM review_read
        WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
          AND branch IN (${lineage.map(() => '?').join(',')})
        ORDER BY recorded_at DESC,record_id DESC`,
      )
      .all(change.project.name, ...lineage)
      .map((row) => ({
        recordId: row.record_id,
        tip: row.tip,
        patchId: row.patch_id,
        pathSet: row.path_set,
        recordedAt: row.recorded_at,
        sessionId: row.session_id,
      })),
  })
}

function overridesForChange(change: PullRequestChange, database: Database): AdmissionOverride[] {
  return database
    .query<
      {
        recordId: string
        project: string
        branch: string
        tip: string
        tree: string
        patchId: string | null
        pathSet: string | null
        attribution: TriageOverrideAttribution
        missingLenses: string
      },
      [string, string]
    >(
      `SELECT record_id AS recordId,project,branch,tip,tree,patch_id AS patchId,path_set AS pathSet,
              attribution,missing_lenses AS missingLenses
       FROM landing_override
       WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
         AND branch=? ORDER BY at DESC,record_id DESC`,
    )
    .all(change.project.name, change.branch)
    .map((row) => ({
      ...row,
      missingLenses: JSON.parse(row.missingLenses) as string[],
    }))
}

function admissionChange(change: PullRequestChange) {
  return {
    project: change.project.name,
    branch: change.branch,
    tip: change.tip,
    tree: change.tree,
    patchId: change.group.patchId,
    pathSet: serializePathSet(change.group.pathSet),
  }
}

export function admissionDecision(
  change: PullRequestChange,
  database: Database,
  triage: TriageDecision = triageDecision(change, database),
): AdmissionDecision {
  return decideAdmission(admissionChange(change), triage, overridesForChange(change, database))
}

export function triageRefusal(
  change: PullRequestChange,
  decision: Exclude<TriageDecision, { complete: true }>,
): string {
  const lines = [
    `refusing pull request for ${change.branch} at ${change.tip}: review triage is incomplete`,
  ]
  if (decision.missingReview) {
    lines.push(
      `missing review for patch ${change.group.patchId}; cleared by: run and record the tier ${change.tier} review for ${change.branch}`,
    )
  }
  if (decision.unfinishedReviewNumbers.length) {
    lines.push(
      `unfinished review${decision.unfinishedReviewNumbers.length === 1 ? '' : 's'} ${decision.unfinishedReviewNumbers.join(', ')}; cleared by: ${decision.unfinishedReviewNumbers.map((number) => `${PLATFORM_SLUG} review complete ${number}`).join('; ')}`,
    )
  }
  if (decision.undisposedFindings.length) {
    lines.push(
      `findings without a disposition: ${decision.undisposedFindings.map((finding) => `${finding.reviewNumber}/${finding.ordinal}`).join(', ')}; cleared by: ${decision.undisposedFindings.map((finding) => `${PLATFORM_SLUG} review triage ${finding.reviewNumber} ${finding.ordinal} <disposition>`).join('; ')}`,
    )
  }
  for (const { lens, recordedOnBranch } of decision.missingLenses) {
    const condition = recordedOnBranch
      ? 'has no recorded result for this change'
      : 'has no recorded result on this branch'
    lines.push(
      `applicable lens ${lens} ${condition}; cleared by: ${PLATFORM_SLUG} run start review-lens --review ${change.branch} --key <task-key> --lens ${lens} "Review ${change.branch} with ${lens}."`,
    )
  }
  if (decision.missingSecondOpinion) {
    const { lens, firstRunId } = decision.missingSecondOpinion
    lines.push(
      `missing second opinion for ${lens} on a different model; cleared by: ${PLATFORM_SLUG} run start review-lens --review ${change.branch} --key <task-key> --lens ${lens} --distinct-from ${firstRunId ?? '<first run>'} "Review ${change.branch} with ${lens}."`,
    )
  }
  if (decision.architectReadRequired) {
    lines.push(
      `architect-read path failed: review ${decision.earlierReviewNumber} can be credited only after an architect reads this exact tip; cleared by: ${PLATFORM_SLUG} review read --sha ${change.tip} --note "<what was read and why it lands>"`,
    )
  } else if (decision.finalTierRaised) {
    lines.push(
      `architect-read path failed: final tip tier ${change.tier} exceeds credited review ${decision.earlierReviewNumber} tier ${decision.earlierReviewTier}; cleared by: run and record a complete tier ${change.tier} review for ${change.branch}`,
    )
  } else if (decision.noCompleteReviewRound) {
    lines.push(
      `architect-read path failed: no earlier complete review round exists on ${change.branch}; cleared by: run and record the tier ${change.tier} review for ${change.branch}`,
    )
  }
  return lines.join('\n')
}

function insertOverride(
  change: PullRequestChange,
  reason: string,
  attribution: TriageOverrideAttribution,
  missingLenses: readonly string[],
  database: Database,
): string {
  const row = database
    .query<
      { record_id: string },
      [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
        string,
      ]
    >(
      `INSERT INTO landing_override
         (record_id,project,project_record_id,branch,tip,tree,patch_id,path_set,reason,attribution,
          missing_lenses,session_id,at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING record_id`,
    )
    .get(
      newRecordId(),
      change.project.name,
      change.project.recordId,
      change.branch,
      change.tip,
      change.tree,
      change.group.patchId,
      serializePathSet(change.group.pathSet),
      reason,
      attribution,
      JSON.stringify(missingLenses),
      sessionId(),
      nowIso(),
    )!
  enqueueLandingOverride(database, row.record_id)
  return row.record_id
}

export function recordTriageOverrideForChange(
  change: PullRequestChange,
  input: {
    overrideReason?: string
    ceilingRuling?: string
    fromOperator: boolean
    reviewBudget?: Pick<ReviewRoundBudgetDecision, 'atCeiling' | 'roundsUsed' | 'ceiling'>
    triage?: TriageDecision
    overrideOption?: string
  },
  database: Database,
): string | null {
  const override = decideTriageOverride({
    ...input,
    commandName: PLATFORM_SLUG,
    triage: input.triage ? ceilingTriageFacts(input.triage) : undefined,
  })
  if (override.kind === 'refuse') throw new Error(override.reason)
  if (override.kind === 'none') return null
  return insertOverride(
    change,
    override.reason,
    override.attribution,
    override.missingLenses,
    database,
  )
}

function guardTriageOverrideService(reasons: readonly (string | undefined)[]): void {
  if (reasons.every((reason) => reason === undefined)) return
  if (reasons.some((reason) => reason !== undefined && containsSecretShaped(reason))) {
    throw new Error('refusing triage override because its reason resembles a secret')
  }
  if (process.env.BOTTEGA_DEPTH !== undefined) {
    throw new Error('triage overrides are reserved for architect sessions; BOTTEGA_DEPTH is set')
  }
}

export function recordTriageOverride(
  reason: string | undefined,
  fromOperator: boolean,
  cwd = process.cwd(),
): string {
  guardTriageOverrideService([reason])
  if (reason === undefined)
    throw new Error(`${PLATFORM_SLUG} pr override requires --reason "<reason>"`)
  const change = resolvePullRequestChange(cwd)
  const database = writableDb()
  return writeTransaction(
    () =>
      recordTriageOverrideForChange(
        change,
        {
          overrideReason: reason,
          fromOperator,
          overrideOption: '--reason',
        },
        database,
      )!,
    database,
  )
}

export function recordTriageIntent(
  change: PullRequestChange,
  decision: TriageDecision,
  overrideId: string | null,
  database: Database,
): string {
  const row = database
    .query(
      `INSERT INTO landing_triage_snapshot
         (record_id,project,project_record_id,branch,tip,tree,pr_number,review_record_ids,patch_id,tier,
          lens_rounds,finding_count,admission_path,read_record_id,override_record_id,session_id,at)
       VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(project,branch,tip) DO UPDATE SET
         tree=excluded.tree,pr_number=NULL,review_record_ids=excluded.review_record_ids,patch_id=excluded.patch_id,
         tier=excluded.tier,lens_rounds=excluded.lens_rounds,
         finding_count=excluded.finding_count,admission_path=excluded.admission_path,
         read_record_id=excluded.read_record_id,override_record_id=excluded.override_record_id,
         session_id=excluded.session_id,at=excluded.at
       RETURNING record_id`,
    )
    .get(
      newRecordId(),
      change.project.name,
      change.project.recordId,
      change.branch,
      change.tip,
      change.tree,
      JSON.stringify(decision.snapshot.reviewRecordIds),
      decision.snapshot.patchId,
      decision.snapshot.tier,
      decision.snapshot.lensRounds,
      decision.snapshot.findingCount,
      decision.snapshot.admissionPath,
      decision.snapshot.readRecordId,
      overrideId,
      sessionId(),
      nowIso(),
    ) as { record_id: string }
  return row.record_id
}

export function finalizeTriageIntent(
  project: string,
  branch: string,
  prNumber: number,
  database: Database = writableDb(),
): string | null {
  return writeTransaction(
    () => finalizeTriageIntentWrite(project, branch, prNumber, database),
    database,
  )
}

function finalizeTriageIntentWrite(
  project: string,
  branch: string,
  prNumber: number,
  database: Database,
): string | null {
  const row = database
    .query<{ record_id: string }, [string, string]>(
      `SELECT record_id FROM landing_triage_snapshot
        WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
          AND branch=? AND pr_number IS NULL ORDER BY at DESC,record_id DESC LIMIT 1`,
    )
    .get(project, branch)
  if (!row) return null
  database
    .query('UPDATE landing_triage_snapshot SET pr_number=? WHERE record_id=?')
    .run(prNumber, row.record_id)
  enqueueLandingTriageSnapshot(database, row.record_id)
  return row.record_id
}

export function recordMergeAdmission(
  change: PullRequestChange,
  decision: AdmissionDecision,
  prNumber: number,
  database: Database,
): string | null {
  return writeTransaction(() => {
    const existing = database
      .query<{ record_id: string }, [string, string, string]>(
        `SELECT record_id FROM landing_triage_snapshot
          WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
            AND branch=? AND tip=? LIMIT 1`,
      )
      .get(change.project.name, change.branch, change.tip)
    if (existing) return null
    recordTriageIntent(change, decision.triage, decision.overrideId, database)
    return finalizeTriageIntentWrite(change.project.name, change.branch, prNumber, database)
  }, database)
}

function pullRequestForBranch(cwd: string, branch: string): { number: number; url: string } | null {
  let process: ReturnType<typeof Bun.spawnSync>
  try {
    process = Bun.spawnSync(['gh', 'pr', 'view', branch, '--json', 'number,url'], {
      cwd,
      env: targetGitEnvironment(cwd),
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    return null
  }
  if (process.exitCode !== 0) return null
  try {
    const value = JSON.parse(process.stdout?.toString() ?? '') as {
      number?: unknown
      url?: unknown
    }
    return Number.isSafeInteger(value.number) && typeof value.url === 'string'
      ? { number: Number(value.number), url: value.url }
      : null
  } catch {
    return null
  }
}

function pendingIntent(database: Database, project: string, branch: string): boolean {
  return Boolean(
    database
      .query(
        'SELECT 1 FROM landing_triage_snapshot WHERE project_record_id=(SELECT record_id FROM project WHERE name=?) AND branch=? AND pr_number IS NULL LIMIT 1',
      )
      .get(project, branch),
  )
}

export function createPullRequest(
  args: string[],
  options: { overrideReason?: string; ceilingRuling?: string; fromOperator?: boolean },
  cwd = process.cwd(),
): { output: string; overrideId: string | null } {
  guardTriageOverrideService([options.overrideReason, options.ceilingRuling])
  const change = resolvePullRequestChange(cwd)
  const existing = pullRequestForBranch(cwd, change.branch)
  if (existing) finalizeTriageIntent(change.project.name, change.branch, existing.number)
  const database = writableDb()
  const checked = writeTransaction(() => {
    const triage = triageDecision(change, database)
    const currentRoundIdentity = currentReviewRoundIdentity({
      branch: change.branch,
      patchId: change.group.patchId,
      pathSet: serializePathSet(change.group.pathSet),
    })
    const budget = reviewBudgetForBranch(
      database,
      change.project.name,
      change.branch,
      currentRoundIdentity,
    )
    const reviewBudget = reviewRoundBudgetDecision({
      tier: change.tier,
      roundsUsed: budget.roundsUsed,
      currentChangeCounted: budget.currentChangeCounted,
    })
    recordTriageOverrideForChange(
      change,
      {
        overrideReason: options.overrideReason,
        ceilingRuling: options.ceilingRuling,
        fromOperator: Boolean(options.fromOperator),
        reviewBudget,
        triage,
      },
      database,
    )
    const decision = admissionDecision(change, database, triage)
    if (!decision.complete && !decision.triage.complete) {
      throw new Error(triageRefusal(change, decision.triage))
    }
    recordTriageIntent(change, decision.triage, decision.overrideId, database)
    return decision
  }, database)

  const trunk = change.project.settings.trunk!.trim()
  let output = ''
  let failure: string | null = null
  try {
    const process = Bun.spawnSync(['gh', 'pr', 'create', ...args, '--base', trunk], {
      cwd,
      env: targetGitEnvironment(cwd),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    output = process.stdout.toString().trim()
    if (process.exitCode !== 0)
      failure = process.stderr.toString().trim() || `exit ${process.exitCode}`
  } catch (cause) {
    failure = String((cause as Error)?.message ?? cause)
  }
  const created = pullRequestForBranch(cwd, change.branch)
  if (created) finalizeTriageIntent(change.project.name, change.branch, created.number)
  if (failure !== null) throw new Error(`gh pr create failed: ${failure}`)
  if (!created) {
    throw new Error(
      `gh pr create succeeded but gh pr view ${change.branch} could not resolve its number; the triage intent remains pending`,
    )
  }
  return {
    output: output || created.url,
    overrideId: checked.overrideId,
  }
}

function recordedRunBranches(database: Database, project: Project): string[] {
  const rows = database
    .query<{ branch: string | null; minted_branch: string | null }, [string]>(
      `SELECT branch,minted_branch FROM run
        WHERE project_record_id=?`,
    )
    .all(project.recordId)
  return [
    ...new Set(rows.flatMap((row) => [row.branch, row.minted_branch]).filter(Boolean)),
  ] as string[]
}

export type PushedTipCheck = {
  known: boolean
  complete: boolean
  infrastructureError: string | null
  refusal: string | null
  pendingIntent: boolean
  overrideId: string | null
}

export function checkPushedTip(cwd: string, sha: string, remoteRef: string): PushedTipCheck {
  try {
    const database = db()
    const project = projectAt(cwd, database)
    if (!project) throw new Error(`project for ${cwd} is not registered`)
    const recordedBranches = recordedRunBranches(database, project)
    const branch = destinationBranch(remoteRef)
    const classification = decidePrePush({
      remoteRef,
      recordedBranches,
      triageComplete: null,
    })
    if (!classification.check || branch === null) {
      return {
        known: false,
        complete: true,
        infrastructureError: null,
        refusal: null,
        pendingIntent: false,
        overrideId: null,
      }
    }
    const tip = git(cwd, ['rev-parse', '--verify', `${sha}^{commit}`])
    const change = resolvePullRequestChange(cwd, tip, database, git, branch)
    const decision = admissionDecision(change, database)
    const policy = decidePrePush({
      remoteRef,
      recordedBranches,
      triageComplete: decision.complete,
    })
    return {
      known: true,
      complete: policy.admit,
      infrastructureError: null,
      refusal:
        !policy.admit && !decision.triage.complete ? triageRefusal(change, decision.triage) : null,
      pendingIntent: pendingIntent(database, project.name, branch),
      overrideId: decision.overrideId,
    }
  } catch (cause) {
    return {
      known: true,
      complete: true,
      infrastructureError: String((cause as Error)?.message ?? cause),
      refusal: null,
      pendingIntent: false,
      overrideId: null,
    }
  }
}
