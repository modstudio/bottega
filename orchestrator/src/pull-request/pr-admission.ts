// concern: pull-request-admission
/** Resolves the caller's exact change, applies triage policy, and records admission evidence. */
import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record/schema.ts'
import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { type Project, projectAt } from '../project/projects.ts'
import { enqueueLandingOverride, enqueueLandingTriageSnapshot } from '../record/landing-outbox.ts'
import {
  branchRunOwnerSession,
  type ChangeGroup,
  measureChangeGroup,
  reviewsForTriage,
  serializePathSet,
} from '../review/review-group.ts'
import { validateTriageOverride } from './override-decision.ts'
import { decidePrePush, destinationBranch } from './pre-push-decision.ts'
import { decideTriage, type TriageDecision } from './triage-decision.ts'

type Git = (cwd: string, args: string[]) => string

export type PullRequestChange = {
  project: Project
  branch: string
  tip: string
  tree: string
  group: ChangeGroup
  tier: 0 | 1 | 2 | 3
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

function resolvePullRequestChange(
  cwd: string,
  sha = 'HEAD',
  database: Database = db(),
  runGit: Git = git,
  branchOverride?: string,
): PullRequestChange {
  const project = projectAt(cwd, database)
  if (!project)
    throw new Error(`cannot resolve a project for ${cwd}; run orch pr from a registered checkout`)
  const branch = branchOverride ?? runGit(cwd, ['branch', '--show-current'])
  if (!branch) throw new Error('orch pr requires a checked-out branch, not detached HEAD')
  const tip = runGit(cwd, ['rev-parse', '--verify', `${sha}^{commit}`])
  const tree = runGit(cwd, ['rev-parse', '--verify', `${tip}^{tree}`])
  const measured = measureChangeGroup(cwd, project, branch, tip)
  if (!measured) throw new Error(`could not measure the change group for ${branch} at ${tip}`)
  return {
    project,
    branch,
    tip,
    tree,
    group: measured.group,
    tier: measured.tier.tier,
  }
}

function triageDecision(change: PullRequestChange, database: Database): TriageDecision {
  const reviews = reviewsForTriage(database, change.group)
  return decideTriage({
    patchId: change.group.patchId,
    pathSet: serializePathSet(change.group.pathSet),
    tip: change.tip,
    tier: change.tier,
    branchOwnerSession: branchRunOwnerSession(database, change.project.name, change.branch),
    reviews: reviews.reviews,
    branchReviews: reviews.branchReviews,
    reads: database
      .query<
        {
          id: number
          tip: string
          patch_id: string
          path_set: string
          recorded_at: string
          session_id: string | null
        },
        [string, string]
      >(
        `SELECT id,tip,patch_id,path_set,recorded_at,session_id FROM review_read
        WHERE project=? AND branch=? ORDER BY id DESC`,
      )
      .all(change.project.name, change.branch)
      .map((row) => ({
        id: row.id,
        tip: row.tip,
        patchId: row.patch_id,
        pathSet: row.path_set,
        recordedAt: row.recorded_at,
        sessionId: row.session_id,
      })),
  })
}

function refusal(
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
  if (decision.unfinishedReviewIds.length) {
    lines.push(
      `unfinished review${decision.unfinishedReviewIds.length === 1 ? '' : 's'} ${decision.unfinishedReviewIds.join(', ')}; cleared by: ${decision.unfinishedReviewIds.map((id) => `orch review complete ${id}`).join('; ')}`,
    )
  }
  if (decision.undisposedFindings.length) {
    lines.push(
      `findings without a disposition: ${decision.undisposedFindings.map((finding) => finding.id).join(', ')}; cleared by: ${decision.undisposedFindings.map((finding) => `orch review triage ${finding.reviewId} ${finding.ordinal} <disposition>`).join('; ')}`,
    )
  }
  if (decision.roundsOwed) {
    lines.push(
      `${decision.roundsOwed} lens round${decision.roundsOwed === 1 ? '' : 's'} still owed for tier ${change.tier}; cleared by: run and record ${decision.roundsOwed} more review lens round${decision.roundsOwed === 1 ? '' : 's'}`,
    )
  }
  if (decision.finalTierRaised) {
    lines.push(
      `architect-read path failed: final tip tier ${change.tier} exceeds credited review ${decision.earlierReviewId} tier ${decision.earlierReviewTier}; cleared by: run and record a complete tier ${change.tier} review for ${change.branch}`,
    )
  } else if (decision.architectReadRequired) {
    lines.push(
      `architect-read path failed: review ${decision.earlierReviewId} can be credited only after an architect reads this exact tip; cleared by: orch review read --sha ${change.tip} --note "<what was read and why it lands>"`,
    )
  } else if (decision.earlierReviewId === null) {
    lines.push(
      `architect-read path failed: no earlier complete review round exists on ${change.branch}; cleared by: run and record the tier ${change.tier} review for ${change.branch}`,
    )
  }
  return lines.join('\n')
}

function insertOverride(change: PullRequestChange, reason: string, database: Database): number {
  const row = database
    .query<
      { id: number },
      [string, string, number, string, string, string, string, string | null, string]
    >(
      `INSERT INTO landing_override
         (record_id,project,project_id,branch,tip,tree,reason,session_id,at)
       VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
    )
    .get(
      newRecordId(),
      change.project.name,
      change.project.id,
      change.branch,
      change.tip,
      change.tree,
      reason,
      sessionId(),
      nowIso(),
    )!
  enqueueLandingOverride(database, row.id)
  return row.id
}

export function recordTriageIntent(
  change: PullRequestChange,
  decision: TriageDecision,
  overrideId: number | null,
  database: Database,
): number {
  const row = database
    .query(
      `INSERT INTO landing_triage_snapshot
         (record_id,project,project_id,branch,tip,tree,pr_number,review_ids,patch_id,tier,
          lens_rounds,finding_count,admission_path,read_id,override_id,session_id,at)
       VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(project,branch,tip) DO UPDATE SET
         tree=excluded.tree,pr_number=NULL,review_ids=excluded.review_ids,patch_id=excluded.patch_id,
         tier=excluded.tier,lens_rounds=excluded.lens_rounds,
         finding_count=excluded.finding_count,admission_path=excluded.admission_path,
         read_id=excluded.read_id,override_id=excluded.override_id,
         session_id=excluded.session_id,at=excluded.at
       RETURNING id`,
    )
    .get(
      newRecordId(),
      change.project.name,
      change.project.id,
      change.branch,
      change.tip,
      change.tree,
      JSON.stringify(decision.snapshot.reviewIds),
      decision.snapshot.patchId,
      decision.snapshot.tier,
      decision.snapshot.lensRounds,
      decision.snapshot.findingCount,
      decision.snapshot.admissionPath,
      decision.snapshot.readId,
      overrideId,
      sessionId(),
      nowIso(),
    ) as { id: number }
  return row.id
}

export function finalizeTriageIntent(
  project: string,
  branch: string,
  prNumber: number,
  database: Database = writableDb(),
): number | null {
  return writeTransaction(() => {
    const row = database
      .query<{ id: number }, [string, string]>(
        `SELECT id FROM landing_triage_snapshot
          WHERE project=? AND branch=? AND pr_number IS NULL ORDER BY id DESC LIMIT 1`,
      )
      .get(project, branch)
    if (!row) return null
    database
      .query('UPDATE landing_triage_snapshot SET pr_number=? WHERE id=?')
      .run(prNumber, row.id)
    enqueueLandingTriageSnapshot(database, row.id)
    return row.id
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
        'SELECT 1 FROM landing_triage_snapshot WHERE project=? AND branch=? AND pr_number IS NULL LIMIT 1',
      )
      .get(project, branch),
  )
}

export function createPullRequest(
  args: string[],
  options: { overrideReason?: string; fromOperator?: boolean },
  cwd = process.cwd(),
): { output: string; overridden: boolean } {
  const reason = validateTriageOverride(options.overrideReason, Boolean(options.fromOperator))
  if (reason !== null && containsSecretShaped(reason)) {
    throw new Error('refusing triage override because its reason resembles a secret')
  }
  const change = resolvePullRequestChange(cwd)
  const existing = pullRequestForBranch(cwd, change.branch)
  if (existing) finalizeTriageIntent(change.project.name, change.branch, existing.number)
  const database = writableDb()
  const checked = writeTransaction(() => {
    const decision = triageDecision(change, database)
    if (!decision.complete && reason === null) throw new Error(refusal(change, decision))
    const overrideId = reason === null ? null : insertOverride(change, reason, database)
    recordTriageIntent(change, decision, overrideId, database)
    return { decision, overrideId }
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
  return { output: output || created.url, overridden: checked.overrideId !== null }
}

function recordedRunBranches(database: Database, project: Project): string[] {
  const rows = database
    .query<{ branch: string | null; minted_branch: string | null }, [number, string]>(
      `SELECT branch,minted_branch FROM run
        WHERE project_id=? OR (project_id IS NULL AND repo=?)`,
    )
    .all(project.id, project.name)
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
}

export function checkPushedTip(cwd: string, sha: string, remoteRef: string): PushedTipCheck {
  try {
    const database = db()
    const project = projectAt(cwd, database)
    if (!project) throw new Error(`project for ${cwd} is not registered`)
    const recordedBranches = recordedRunBranches(database, project)
    const branch = destinationBranch(remoteRef)
    const classification = decidePrePush({ remoteRef, recordedBranches, triageComplete: null })
    if (!classification.check || branch === null) {
      return {
        known: false,
        complete: true,
        infrastructureError: null,
        refusal: null,
        pendingIntent: false,
      }
    }
    const tip = git(cwd, ['rev-parse', '--verify', `${sha}^{commit}`])
    const change = resolvePullRequestChange(cwd, tip, database, git, branch)
    const decision = triageDecision(change, database)
    const policy = decidePrePush({ remoteRef, recordedBranches, triageComplete: decision.complete })
    return {
      known: true,
      complete: policy.admit,
      infrastructureError: null,
      refusal: !policy.admit && !decision.complete ? refusal(change, decision) : null,
      pendingIntent: pendingIntent(database, project.name, branch),
    }
  } catch (cause) {
    return {
      known: true,
      complete: true,
      infrastructureError: String((cause as Error)?.message ?? cause),
      refusal: null,
      pendingIntent: false,
    }
  }
}
