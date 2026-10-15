// concern: review-commands
/** Knows review command semantics and presentation. Must not know runs, transports, routing by value, the CLI, or worktrees by value. */
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { gitToplevel } from '../../../shared/git.ts'
import { DB_PATH, db } from '../database/db.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { job } from '../jobs/jobs.ts'
import { formatLensProfileSource, resolveLens } from '../lens/lenses.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import { classifyRunIdentifier, resolveRunIdentifier } from '../run/run-identifier.ts'
import { getReview, listReviews, parseReviewOutput, recordReviews } from './review.ts'
import { reviewCalibration, reviewCalibrationFleet } from './review-calibration.ts'
import { resolveReviewCommandCwd } from './review-command-cwd.ts'
import { coverageAudit } from './review-coverage.ts'
import { REVIEW_WINDOW } from './review-evidence-sql.ts'
import { serializePathSet } from './review-group.ts'
import { measureChangeIdentity, reviewPins } from './review-pins.ts'
import { reviewBudgetForBranch, reviewRoundBudgetDecision } from './review-round-budget.ts'
import { resolveReviewMergeBase, reviewTrunkRef } from './review-target.ts'
import { parseTierRange, resolveTierRange, type TierRangeEndpoint } from './review-tier.ts'
import { reviewTierForRange } from './review-tier-service.ts'
import {
  completeReview,
  DISPOSITIONS,
  type Disposition,
  MIN_REVIEW_TRIAGED,
  triageFinding,
} from './review-triage.ts'
import { REVIEW_SEVERITY } from './review-vocabulary.ts'
import { reviewRoundIdentity } from './review-yield.ts'

type ReviewFlags = { has(name: string): boolean; flag(name: string): string | undefined }
type ReviewPresentation = { log(...values: unknown[]): void; usage(): never }

function printReviewFinding(
  finding: ReturnType<typeof getReview>['findings'][number],
  log: (...values: unknown[]) => void,
): void {
  log(
    `finding ${finding.ordinal} ${finding.severity} ${finding.location} disposition=${finding.disposition ?? 'untriaged'} category=${finding.rejection_category ?? '—'}`,
  )
  log(`  evidence: ${finding.evidence}`)
  log(`  correction: ${finding.proposed_correction}`)
  for (const amendment of finding.amendments) {
    log(
      `  amendment ${amendment.at} actor=${amendment.actor_session ?? '—'} ` +
        `disposition=${amendment.old_disposition ?? '—'}->${amendment.new_disposition} ` +
        `category=${amendment.old_rejection_category ?? '—'}->${amendment.new_rejection_category ?? '—'} ` +
        `severity=${amendment.old_triaged_severity ?? '—'}->${amendment.new_triaged_severity ?? '—'}`,
    )
    log(`    reason: ${amendment.reason}`)
  }
}

function resolveTierRangeInRepo(repo: string, from: string, to: string, fromLabel = from) {
  const endpoint = (ref: string, label = ref): TierRangeEndpoint => {
    const peeled = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: repo,
      env: targetGitEnvironment(repo),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (peeled.exitCode === 0) {
      return { ref: label, commit: peeled.stdout.toString().trim(), kind: 'commit' }
    }
    const object = Bun.spawnSync(['git', 'cat-file', '-t', ref], {
      cwd: repo,
      env: targetGitEnvironment(repo),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (object.exitCode !== 0) return { ref: label, commit: null, kind: 'unresolvable' }
    const kind = object.stdout.toString().trim()
    return { ref: label, commit: null, kind: kind === 'tree' ? 'tree' : 'other' }
  }
  const fromEndpoint = endpoint(from, fromLabel)
  const toEndpoint = endpoint(to)
  const base =
    fromEndpoint.kind === 'commit' && toEndpoint.kind === 'commit'
      ? Bun.spawnSync(['git', 'merge-base', fromEndpoint.commit!, toEndpoint.commit!], {
          cwd: repo,
          env: targetGitEnvironment(repo),
          stdout: 'pipe',
          stderr: 'pipe',
        })
      : null
  const resolution = resolveTierRange({
    from: fromEndpoint,
    to: toEndpoint,
    mergeBase: base?.exitCode === 0 ? base.stdout.toString().trim() || null : null,
  })
  if ('refusal' in resolution) throw new Error(resolution.refusal)
  return resolution
}

function resolveTierTarget(
  value: string,
  cwd: string,
): {
  repo: string
  from: string
  to: string
  branch: string
  project: NonNullable<ReturnType<typeof projectAt>>
} {
  if (classifyRunIdentifier(value)) {
    return (() => {
      const runId = resolveRunIdentifier(db(), value)
      const row = db()
        .query('SELECT repo, job, branch, base_commit, input_tree, head_commit FROM run WHERE id=?')
        .get(runId) as {
        repo: string | null
        job: string
        branch: string | null
        base_commit: string | null
        input_tree: string | null
        head_commit: string | null
      } | null
      if (!row) throw new Error(`no run ${runId}`)
      const project = row.repo ? projectByName(row.repo) : null
      if (!project) throw new Error(`run ${runId} has no registered project`)
      if (!row.base_commit) throw new Error(`run ${runId} has no recorded base commit`)
      // A writer run's input tree IS its base: what it built lives on its
      // branch. Measure the branch tip when the branch still exists. A
      // reader's input tree is the artifact it reviewed, so a reader keeps
      // it even when a branch is recorded.
      const writer = (() => {
        try {
          return job(row.job).needs.writesRepo
        } catch {
          return false
        }
      })()
      const branchLive =
        writer &&
        row.branch &&
        Bun.spawnSync(['git', 'show-ref', '--verify', '--quiet', `refs/heads/${row.branch}`], {
          cwd: project.path,
          env: targetGitEnvironment(project.path),
          stdout: 'pipe',
          stderr: 'pipe',
        }).exitCode === 0
      const reviewed = branchLive ? `refs/heads/${row.branch}` : (row.input_tree ?? row.head_commit)
      if (!reviewed) throw new Error(`run ${runId} has no recorded input tree or head commit`)
      if (!branchLive)
        return {
          repo: project.path,
          from: row.base_commit,
          to: reviewed,
          branch: row.branch ?? reviewed,
          project,
        }
      const trunk = project.settings.trunk?.trim()
      if (!trunk) throw new Error(`project ${project.name} has no trunk configured`)
      const from = (() => {
        try {
          return resolveReviewMergeBase(project.path, reviewed, trunk)
        } catch {
          return null
        }
      })()
      if (!from) {
        throw new Error(`cannot find merge-base between branch ${row.branch} and trunk ${trunk}`)
      }
      return { repo: project.path, from, to: reviewed, branch: row.branch!, project }
    })()
  }

  const project = projectAt(cwd)
  if (!project) throw new Error('review tier target is not inside a registered project')
  const repo = gitToplevel(cwd)
  if (!repo) {
    throw new Error(
      `cannot resolve the caller's git top-level; run review tier from a git checkout of project ${project.name}`,
    )
  }
  const range = parseTierRange(value)
  if (range && 'refusal' in range) throw new Error(range.refusal)
  if (range) {
    return {
      repo,
      ...resolveTierRangeInRepo(repo, range.from, range.to),
      branch: range.to,
      project,
    }
  }

  const branch = Bun.spawnSync(['git', 'show-ref', '--verify', '--quiet', `refs/heads/${value}`], {
    cwd: repo,
    env: targetGitEnvironment(repo),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (branch.exitCode !== 0) {
    throw new Error('review tier accepts a branch, run id, or explicit <from>..<to> range')
  }
  const trunk = typeof project.settings.trunk === 'string' ? project.settings.trunk.trim() : ''
  if (!trunk) throw new Error(`project ${project.name} has no trunk configured`)
  const remoteTrackingRefExists =
    Bun.spawnSync(['git', 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${trunk}`], {
      cwd: repo,
      env: targetGitEnvironment(repo),
      stdout: 'pipe',
      stderr: 'pipe',
    }).exitCode === 0
  return {
    repo,
    ...resolveTierRangeInRepo(repo, reviewTrunkRef(remoteTrackingRefExists, trunk), value, trunk),
    branch: value,
    project,
  }
}

function reviewTierOutput(value: string, cwd: string) {
  const { repo, from, to, branch, project } = resolveTierTarget(value, cwd)
  const output = reviewTierForRange(repo, from, to, project.settings.review)
  const identity = measureChangeIdentity(repo, from, to)
  const currentRoundIdentity = identity
    ? reviewRoundIdentity({
        launch_key: null,
        branch,
        patch_id: identity.patchId,
        path_set: serializePathSet(identity.paths),
      }).identity
    : null
  const branchBudget = reviewBudgetForBranch(db(), project.name, branch, currentRoundIdentity)
  const reviewBudget = reviewRoundBudgetDecision({
    tier: output.tier,
    ...branchBudget,
  })
  return {
    ...output,
    review_budget: {
      ...reviewBudget,
      eligibleReviewCount: branchBudget.eligibleReviewCount,
      unclassifiableReviewCount: branchBudget.unclassifiableReviewCount,
    },
    lens_profiles: output.lenses.map((id) => ({
      id,
      profiles: resolveLens(id, project.name)?.profiles ?? [],
    })),
  }
}

function printReviewTier(
  output: ReturnType<typeof reviewTierOutput>,
  json: boolean,
  log: (...values: unknown[]) => void,
): void {
  if (json) {
    log(JSON.stringify(output))
    return
  }
  log(`tier ${output.tier}`)
  log(`risk ${output.risk}`)
  log(`size ${output.size}`)
  if (output.review_budget.unclassifiableReviewCount > 0) {
    log(
      `rounds at least ${output.review_budget.roundsUsed}/${output.review_budget.ceiling}; ` +
        `round count is unknown for ${output.review_budget.unclassifiableReviewCount} eligible ` +
        `review${output.review_budget.unclassifiableReviewCount === 1 ? '' : 's'} because the task or patch identity is missing`,
    )
  } else {
    log(`rounds ${output.review_budget.roundsUsed}/${output.review_budget.ceiling}`)
  }
  log(
    output.review_budget.currentChangeCounted
      ? 'current change is already a counted round; no new round consumed'
      : 'current change would start a new round',
  )
  if (
    output.review_budget.unclassifiableReviewCount === 0 &&
    output.review_budget.wouldExceedCeiling
  ) {
    log('a new round would exceed the ceiling; stop and ask the operator')
  }
  for (const lens of output.lens_profiles) {
    const sources = lens.profiles
      .map((profile) => formatLensProfileSource(profile, 'source'))
      .join(', ')
    log(`lens ${lens.id}${sources ? `  ${sources}` : ''}`)
  }
  for (const reason of output.reasons) log(reason)
}

export function listReviewCommand(flags: ReviewFlags, presentation: ReviewPresentation): void {
  const { has, flag } = flags
  const { log } = presentation
  if (has('open') && has('complete'))
    throw new Error('--open and --complete are mutually exclusive')
  const since = flag('since')
  if (since && !z.iso.datetime().safeParse(since).success) {
    throw new Error('--since must be an ISO datetime (for example 2026-01-01T00:00:00Z)')
  }
  const rows = listReviews({
    state: has('open') ? 'open' : has('complete') ? 'complete' : undefined,
    project: flag('project'),
    since,
  })
  if (has('json')) log(JSON.stringify(rows))
  else if (!rows.length) log('no reviews')
  else {
    log(
      'id  recorded_at               completed  project  branches  tier/risk/size  lenses  findings t/tr/a/m/r/s  coverage',
    )
    for (const row of rows)
      log(
        `${String(row.id).padEnd(3)} ${row.recorded_at.padEnd(25)} ${row.completed_at ? 'yes' : 'no '}        ` +
          `${(row.project ?? '—').padEnd(8)} ${(row.branches.join(',') || '—').padEnd(9)} ` +
          `${`${row.tier ?? '—'}/${row.risk ?? '—'}/${row.size ?? '—'}`.padEnd(14)} ${String(row.lens_count).padEnd(7)} ` +
          `${row.findings.total}/${row.findings.triaged}/${row.findings.accepted}/${row.findings.modified}/${row.findings.rejected}/${row.findings.skipped}              ${row.coverage ?? '—'}`,
      )
  }
}

export function showReviewCommand(
  argv: string[],
  flags: ReviewFlags,
  { log }: ReviewPresentation,
): void {
  const reviewId = Number(argv[2])
  if (!Number.isInteger(reviewId) || reviewId <= 0)
    throw new Error(`${PLATFORM_SLUG} review show <id> [--json]`)
  const review = getReview(reviewId)
  if (flags.has('json')) log(JSON.stringify(review))
  else {
    log(
      `review ${review.id} recorded=${review.recorded_at} completed=${review.completed_at ?? '—'} projects=${review.projects.join(',') || '—'} tier/risk/size=${review.tier ?? '—'}/${review.risk ?? '—'}/${review.size ?? '—'} current=${review.current_class ?? '—'}`,
    )
    if (review.outdated_reason) log(`outdated ${review.outdated_at}: ${review.outdated_reason}`)
    for (const lens of review.lenses) {
      log(
        `lens run ${lens.run_id}: ${lens.lens} ${lens.agent}/${lens.model ?? '—'} tree=${lens.reviewed_tree ?? '—'} head=${lens.head_commit ?? '—'}`,
      )
      log(`  ref ${lens.review_ref}: ${lens.pin.resolves ? lens.pin.commit : 'unresolved'}`)
      log(
        `  grading ${Object.entries(lens.grading)
          .map(([key, value]) => `${key}=${value ?? '—'}`)
          .join(' ')}`,
      )
    }
    for (const finding of review.findings) printReviewFinding(finding, log)
  }
}

export async function yieldReviewCommand(
  flags: ReviewFlags,
  { log }: ReviewPresentation,
): Promise<void> {
  const since = flags.flag('since')
  if (since && !z.iso.datetime().safeParse(since).success) {
    throw new Error('--since must be an ISO datetime (for example 2026-01-01T00:00:00Z)')
  }
  if (flags.flag('task') && flags.flag('key'))
    throw new Error('--task and --key are aliases; supply only one')
  const { reviewYield, renderReviewYieldHuman } = await import('./review-yield.ts')
  const database = new Database(DB_PATH, { readonly: true })
  try {
    const report = reviewYield(
      {
        project: flags.flag('project'),
        since,
        task: flags.flag('task') ?? flags.flag('key'),
        lens: flags.flag('lens'),
        agent: flags.flag('agent'),
      },
      database,
    )
    log(flags.has('json') ? JSON.stringify(report) : renderReviewYieldHuman(report))
  } finally {
    database.close()
  }
}

export function tierReviewCommand(
  argv: string[],
  flags: ReviewFlags,
  { log }: ReviewPresentation,
): void {
  const value = argv[2]
  if (!value) throw new Error(`${PLATFORM_SLUG} review tier <branch|run-id|from..to> [--json]`)
  printReviewTier(
    reviewTierOutput(value, resolveReviewCommandCwd(flags.flag('cwd'))),
    flags.has('json'),
    log,
  )
}

export function coverageAuditReviewCommand(flags: ReviewFlags, { log }: ReviewPresentation): void {
  const database = new Database(DB_PATH, { readonly: true })
  try {
    const audit = coverageAudit(database)
    if (flags.has('json')) log(JSON.stringify(audit))
    else
      log(
        `${audit.count} completed review${audit.count === 1 ? '' : 's'} reviewed trunk` +
          (audit.review_ids.length ? `: ${audit.review_ids.join(', ')}` : '') +
          `\npartial reviews: ${
            audit.partial_review_ids.length ? audit.partial_review_ids.join(', ') : 'none'
          }`,
      )
  } finally {
    database.close()
  }
}

export function recordReviewCommand(
  argv: string[],
  _flags: ReviewFlags,
  { log }: ReviewPresentation,
): void {
  const runIds = argv.slice(2).map((value) => resolveRunIdentifier(db(), value))
  if (!runIds.length) throw new Error(`${PLATFORM_SLUG} review record <run-id>...`)
  const entries = runIds.map((runId) => {
    const row = db().query('SELECT output_path FROM run WHERE id=?').get(runId) as {
      output_path: string | null
    } | null
    if (!row?.output_path || !existsSync(row.output_path)) {
      throw new Error(`run ${runId} has no recorded output`)
    }
    const output = parseReviewOutput(readFileSync(row.output_path, 'utf8'))
    if (!output) throw new Error(`run ${runId} output does not satisfy the review contract`)
    return { runId, output }
  })
  const reviewId = recordReviews(entries)
  const mirrorRuns = entries
    .filter(({ runId }) => {
      const row = db().query(`SELECT mcp_connected, mcp_error FROM run WHERE id=?`).get(runId) as {
        mcp_connected: number | null
        mcp_error: string | null
      }
      return row.mcp_connected === 0 && row.mcp_error?.startsWith('mirror:')
    })
    .map(({ runId }) => runId)
  log(
    `recorded review ${reviewId}` +
      (mirrorRuns.length
        ? ` — MIRROR lens run${mirrorRuns.length === 1 ? '' : 's'} ${mirrorRuns.join(', ')}`
        : ''),
  )
}

export function triageReviewCommand(
  argv: string[],
  flags: ReviewFlags,
  { log }: ReviewPresentation,
): void {
  const reviewId = Number(argv[2])
  const finding = Number(argv[3])
  const disposition = argv[4] as Disposition
  if (!reviewId || !finding || !DISPOSITIONS.includes(disposition)) {
    throw new Error(
      `${PLATFORM_SLUG} review triage <review-id> <finding> <accepted|modified|rejected|skipped> [--category X] [--severity ${REVIEW_SEVERITY.join('|')}]`,
    )
  }
  triageFinding(reviewId, finding, disposition, flags.flag('category'), flags.flag('severity'))
  log(`triaged review ${reviewId} finding ${finding}: ${disposition}`)
}

export function completeReviewCommand(
  argv: string[],
  _flags: ReviewFlags,
  { log }: ReviewPresentation,
): void {
  const reviewId = Number(argv[2])
  if (!reviewId) throw new Error(`${PLATFORM_SLUG} review complete <review-id>`)
  completeReview(reviewId)
  log(`completed review ${reviewId}`)
}

export function pinsReviewCommand(flags: ReviewFlags, { log }: ReviewPresentation): void {
  const pins = reviewPins(flags.has('prune'))
  if (!pins.length) {
    log('no review pins')
    return
  }
  for (const pin of pins) {
    log(
      `${pin.project} review ${pin.reviewId} run ${pin.runId} ${pin.commit} ` +
        `completed=${pin.completed} superseded=${pin.superseded} landed=${pin.landed}` +
        (pin.deleted ? ' deleted' : ''),
    )
  }
}

export function calibrationReviewCommand(
  argv: string[],
  flags: ReviewFlags,
  { log }: ReviewPresentation,
): void {
  const [lens, agent, model] = argv.slice(2).filter((value) => value !== '--json')
  if (!lens && !agent && !model) {
    const fleet = reviewCalibrationFleet()
    if (flags.has('json')) log(JSON.stringify(fleet))
    else {
      log(
        `review calibration fleet (last ${REVIEW_WINDOW} completed reviews; precision floor ${MIN_REVIEW_TRIAGED} triaged)`,
      )
      if (!fleet.length) log('no review calibration evidence')
      for (const cell of fleet)
        log(
          `${cell.lens}/${cell.agent}/${cell.model ?? '—'} n=${cell.n} ` +
            (cell.n < MIN_REVIEW_TRIAGED
              ? `below floor (${cell.n}/${MIN_REVIEW_TRIAGED} triaged)`
              : `precision=${cell.precision!.toFixed(2)}`) +
            ` basis=${cell.basis ?? '—'} last_graded_at=${cell.last_graded_at ?? '—'}`,
        )
    }
    return
  }
  if (!lens || !agent || !model)
    throw new Error(`${PLATFORM_SLUG} review calibration [<lens> <agent> <model>] [--json]`)
  const calibration = reviewCalibration(lens, agent, model)
  if (flags.has('json')) {
    log(JSON.stringify(calibration))
  } else {
    log(
      calibration.precision === null
        ? `${lens}/${agent}: insufficient evidence (${calibration.triaged} triaged)`
        : `${lens}/${agent}: ${calibration.precision.toFixed(2)} (${calibration.hits}/${calibration.triaged}, ${calibration.basis})`,
    )
    log(`  MCP: MIRROR=${calibration.mirror_lenses}`)
    for (const name of ['reproduced', 'coverage', 'limits', 'overlap'] as const) {
      const distribution = calibration[name]
      const cells = Object.keys(distribution.counts).map((value) => {
        const count = distribution.counts[value as keyof typeof distribution.counts]
        const share = distribution.shares[value as keyof typeof distribution.shares]
        return `${value}=${count}${share === null ? '' : ` (${(share * 100).toFixed(0)}%)`}`
      })
      log(`  ${name}: ${cells.join(', ')}, ungraded=${distribution.ungraded}`)
    }
    const severity = calibration.severity
    log(
      `  severity: agreed=${severity.counts.agreed}, changed=${severity.counts.changed}, not-comparable=${severity.counts.not_comparable}, not-assessed=${severity.counts.not_assessed}`,
    )
    for (const [tier, counts] of Object.entries(calibration.tiers)) {
      log(
        `  tier ${tier}: reviews=${counts.reviews}, lenses=${counts.lenses}, accepted=${counts.findings_accepted}, rejected=${counts.findings_rejected}, rounds=${counts.rounds.min ?? '—'}/${counts.rounds.median ?? '—'}/${counts.rounds.max ?? '—'} min/median/max`,
      )
    }
  }
}
