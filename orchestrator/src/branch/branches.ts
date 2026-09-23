// concern: branches
/** Observes registered projects and assembles the run-minted branch report. */

import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import type { Project } from '../project/projects.ts'
import { projectByName, projects } from '../project/projects.ts'
import { type PullRequestLandingEvidence, verifyBranchLanding } from './branch-landing-record.ts'
import { settleDeletedBranch } from './branch-settlement.ts'
import {
  type BranchLandingRecord,
  type BranchStateDecision,
  decideBranchState,
  decideProtectedBranch,
  decidePruneEligibility,
  findRecordedBranchLanding,
  type PatchEquivalentForm,
  pullRequestCarriesKey,
} from './branch-state.ts'
import {
  GH_MERGED_PR_LIMIT,
  type MergedPullRequest,
  mergedPullRequests,
  type PullRequestCommitCheck,
  type PullRequestNameCheck,
  pullRequestCommitCheck,
  pullRequestNameCheck,
} from './merged-pull-request.ts'
import {
  decideOtherBranchState,
  decideOtherPruneEligibility,
  isHeldBranch,
  type OtherBranchLanding,
  taskKeyToken,
} from './other-branch-state.ts'
import {
  isTaskBranchSuperseded,
  type TaskBranchRunRow,
  taskBranchPatchEquivalent,
} from './task-branch.ts'

type RunRow = {
  id: number
  parent_run_id: number | null
  launch_key: string | null
  branch: string | null
  minted_branch: string | null
  launch_base: string | null
  status: string
}

type BranchReportRow = BranchStateDecision & {
  branch: string
  tip: string
  commitsNotOnTrunk: number
  checkedOut: boolean
  liveRun: boolean
  runIds: number[]
}

type OtherBranchReportRow = OtherBranchLanding & {
  branch: string
  tip: string
  commitsNotOnTrunk: number
  checkedOut: boolean
  lastCommitAt: string
  remoteExists: boolean
}

type BranchReportProject = {
  project: string
  trunk: string
  error?: string
  truncated: boolean
  protected: { branch: string; runIds: number[] }[]
  keys: { key: string; branches: BranchReportRow[] }[]
  other?: OtherBranchReportRow[]
}

export type BranchesReport = { projects: BranchReportProject[] }

export type BranchPruneReport = {
  project: string
  key: string | null
  allLocal: boolean
  dryRun: boolean
  deleted: string[]
  wouldDelete: string[]
  kept: { branch: string; reason: string }[]
  operator: {
    branch: string
    state: 'unlanded' | 'unknown'
    commitsNotOnTrunk: number
    command: string
  }[]
  errors: string[]
}

type BranchLandingRecordRow = {
  project: string
  branch: string
  tip: string
  pr_number: number
  merge_commit: string | null
  merged_at: string
}

function command(cwd: string, argv: string[], label: string): string {
  let process: ReturnType<typeof Bun.spawnSync>
  try {
    // Output is parsed, so a forced-colour environment must not reach gh or git.
    const { FORCE_COLOR: _force, CLICOLOR_FORCE: _clicolor, ...env } = targetGitEnvironment(cwd)
    process = Bun.spawnSync(argv, {
      cwd,
      env: { ...env, NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (error) {
    throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (process.exitCode !== 0) {
    throw new Error(
      `${label} failed: ${process.stderr?.toString().trim() || `exit ${process.exitCode}`}`,
    )
  }
  return process.stdout?.toString().trim() ?? ''
}

function git(cwd: string, ...args: string[]): string {
  return command(cwd, ['git', ...args], `git ${args.join(' ')}`)
}

function recordedBranchLandings(): BranchLandingRecord[] {
  const rows = db()
    .query(
      `SELECT project,branch,tip,pr_number,merge_commit,merged_at
         FROM branch_landing_record
        ORDER BY project,branch`,
    )
    .all() as BranchLandingRecordRow[]
  return rows.map((row) => ({
    project: row.project,
    branch: row.branch,
    tip: row.tip,
    number: row.pr_number,
    mergeCommit: row.merge_commit,
    mergedAt: row.merged_at,
  }))
}

function projectRuns(project: Project): RunRow[] {
  return db()
    .query(
      `SELECT id,parent_run_id,launch_key,branch,minted_branch,launch_base,status
         FROM run
        WHERE project_id=? OR (project_id IS NULL AND repo=?)
        ORDER BY id`,
    )
    .all(project.id, project.name) as RunRow[]
}

function localBranches(project: Project): Map<string, string> {
  return new Map(
    [...localBranchDetails(project)].map(([branch, detail]) => [branch, detail.tip] as const),
  )
}

type LocalBranchDetail = { tip: string; lastCommitAt: string }

function localBranchDetails(project: Project): Map<string, LocalBranchDetail> {
  const rows = git(
    project.path,
    'for-each-ref',
    '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)',
    'refs/heads',
  )
  const branches = new Map<string, LocalBranchDetail>()
  for (const line of rows.split('\n')) {
    if (!line) continue
    const [branch, tip, lastCommitAt, ...extra] = line.split('\t')
    if (!branch || !tip || !lastCommitAt || extra.length) {
      throw new Error(`git for-each-ref returned an unexpected row: ${line}`)
    }
    branches.set(branch, { tip, lastCommitAt })
  }
  return branches
}

function remoteBranches(project: Project): Set<string> {
  const branches = new Set<string>()
  for (const line of git(project.path, 'ls-remote', '--heads', 'origin').split('\n')) {
    if (!line) continue
    const match = line.match(/^[0-9a-f]+\trefs\/heads\/(.+)$/)
    if (!match?.[1]) throw new Error(`git ls-remote returned an unexpected row: ${line}`)
    branches.add(match[1])
  }
  return branches
}

function checkedOutBranches(project: Project): Set<string> {
  const checkedOut = new Set<string>()
  for (const line of git(project.path, 'worktree', 'list', '--porcelain').split('\n')) {
    if (line.startsWith('branch refs/heads/'))
      checkedOut.add(line.slice('branch refs/heads/'.length))
  }
  return checkedOut
}

function branchReportFor(
  project: Project,
  options: { key?: string; allLocal?: boolean },
): BranchReportProject {
  const trunk = project.settings.trunk?.trim() ?? ''
  if (!trunk) throw new Error(`project ${project.name} has no trunk configured`)
  const productionBranch = project.settings.productionBranch?.trim() ?? ''
  git(project.path, 'remote', 'get-url', 'origin')
  const { pullRequests: listedPullRequests, truncated } = mergedPullRequests(project)
  const pullRequests = listedPullRequests.sort((left, right) =>
    right.mergedAt.localeCompare(left.mergedAt),
  )
  const fetchedPullRequests = new Map<number, string | null>()
  const runs = projectRuns(project)
  const branchDetails = localBranchDetails(project)
  const branches = new Map(
    [...branchDetails].map(([branch, detail]) => [branch, detail.tip] as const),
  )
  const checkedOut = checkedOutBranches(project)
  const recordedLandings = recordedBranchLandings()
  const trunkTip = git(
    project.path,
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${trunk}^{commit}`,
  )
  const minted = new Map<string, Map<string, RunRow[]>>()
  const protectedRuns = new Map<string, RunRow[]>()
  for (const run of runs) {
    if (!run.minted_branch || !branches.has(run.minted_branch)) continue
    const key = run.launch_key ?? 'unkeyed'
    if (options.key !== undefined && key !== options.key) continue
    if (
      decideProtectedBranch({
        branch: run.minted_branch,
        trunk,
        productionBranch,
      }) !== null
    ) {
      protectedRuns.set(run.minted_branch, [...(protectedRuns.get(run.minted_branch) ?? []), run])
      continue
    }
    const byBranch = minted.get(key) ?? new Map<string, RunRow[]>()
    byBranch.set(run.minted_branch, [...(byBranch.get(run.minted_branch) ?? []), run])
    minted.set(key, byBranch)
  }

  const keys = [...minted]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, byBranch]) => {
      const keyRows = runs
        .filter((run) => (run.launch_key ?? 'unkeyed') === key && run.branch !== null)
        .map(
          (run): TaskBranchRunRow => ({
            id: run.id,
            parent_run_id: run.parent_run_id,
            branch: run.branch!,
            launch_base: run.launch_base,
          }),
        )
      const observed = [...byBranch].map(([branch, branchRuns]) => {
        const tip = branches.get(branch)!
        const commitCount = Number(git(project.path, 'rev-list', '--count', tip, '--not', trunkTip))
        if (!Number.isSafeInteger(commitCount) || commitCount < 0) {
          throw new Error(`git rev-list returned an invalid commit count for ${branch}`)
        }
        const matchingPr = pullRequests.some((pr) => pr.headRefName === branch)
        let patchEquivalent = null
        if (!matchingPr && commitCount > 0) {
          const mergeBase = git(project.path, 'merge-base', trunkTip, tip)
          patchEquivalent = taskBranchPatchEquivalent({
            cwd: project.path,
            trunkTip,
            branchTip: tip,
            mergeBase,
            commitMessage: `orch branch report ${branch}`,
          })
        }
        return {
          branch,
          tip,
          commitsNotOnTrunk: commitCount,
          checkedOut: checkedOut.has(branch),
          liveRun: branchRuns.some((run) => run.status === 'running' || run.status === 'asking'),
          runIds: branchRuns.map((run) => run.id),
          patchEquivalent: patchEquivalent as PatchEquivalentForm | null,
          pullRequestCommitCheck:
            !matchingPr && commitCount > 0 && !patchEquivalent && key !== 'unkeyed'
              ? pullRequestCommitCheck(
                  project,
                  pullRequests.filter((pullRequest) => pullRequestCarriesKey(pullRequest, key)),
                  tip,
                  fetchedPullRequests,
                )
              : null,
          recordedLanding: findRecordedBranchLanding(recordedLandings, project.name, branch),
          superseded: isTaskBranchSuperseded(branch, keyRows),
          turns: new Map(branchRuns.map((run) => [run.parent_run_id ?? run.id, run.id] as const)),
        }
      })
      const decided = new Map<string, BranchStateDecision>()
      for (const row of [...observed].sort(
        (left, right) => Math.max(...right.runIds) - Math.max(...left.runIds),
      )) {
        const laterTurnBranches = observed
          .filter(
            (candidate) =>
              candidate.branch !== row.branch &&
              [...row.turns].some(
                ([root, turn]) => (candidate.turns.get(root) ?? Number.NEGATIVE_INFINITY) > turn,
              ),
          )
          .flatMap((candidate) => {
            const state = decided.get(candidate.branch)
            return state ? [{ branch: candidate.branch, state }] : []
          })
        decided.set(
          row.branch,
          decideBranchState({
            branch: row.branch,
            tip: row.tip,
            mergedPullRequests: pullRequests,
            mergedPullRequestsTruncated: truncated,
            commitsNotOnTrunk: row.commitsNotOnTrunk,
            patchEquivalent: row.patchEquivalent,
            pullRequestCommitCheck: row.pullRequestCommitCheck,
            recordedLanding: row.recordedLanding,
            laterTurnBranches,
            superseded: row.superseded,
          }),
        )
      }
      const reportBranches = observed
        .sort((left, right) => left.branch.localeCompare(right.branch))
        .map(
          ({
            patchEquivalent: _patchEquivalent,
            pullRequestCommitCheck: _pullRequestCommitCheck,
            recordedLanding: _recordedLanding,
            superseded: _superseded,
            turns: _turns,
            ...row
          }) => ({ ...row, ...decided.get(row.branch)! }) satisfies BranchReportRow,
        )
      return { key, branches: reportBranches }
    })
  const protectedBranches = [...protectedRuns]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([branch, branchRuns]) => ({
      branch,
      runIds: branchRuns.map((run) => run.id),
    }))
  const report: BranchReportProject = {
    project: project.name,
    trunk,
    truncated,
    protected: protectedBranches,
    keys,
  }
  if (options.allLocal) {
    const mintedNames = new Set(
      runs.flatMap((run) => (run.minted_branch ? [run.minted_branch] : [])),
    )
    const remotes = remoteBranches(project)
    report.other = [...branchDetails]
      .filter(
        ([branch]) =>
          !mintedNames.has(branch) &&
          decideProtectedBranch({ branch, trunk, productionBranch }) === null,
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([branch, detail]) =>
        otherBranchReportRow({
          project,
          branch,
          detail,
          trunkTip,
          pullRequests,
          truncated,
          checkedOut,
          remotes,
          fetchedPullRequests,
        }),
      )
  }
  return report
}

function otherBranchReportRow(input: {
  project: Project
  branch: string
  detail: LocalBranchDetail
  trunkTip: string
  pullRequests: readonly MergedPullRequest[]
  truncated: boolean
  checkedOut: ReadonlySet<string>
  remotes: ReadonlySet<string>
  fetchedPullRequests: Map<number, string | null>
}): OtherBranchReportRow {
  const { project, branch, detail } = input
  let commitsNotOnTrunk = 0
  let patchEquivalent: PatchEquivalentForm | null = null
  let commitCheck: PullRequestCommitCheck = null
  let nameCheck: PullRequestNameCheck = null
  let checkError: string | undefined
  try {
    commitsNotOnTrunk = Number(
      git(project.path, 'rev-list', '--count', detail.tip, '--not', input.trunkTip),
    )
    if (!Number.isSafeInteger(commitsNotOnTrunk) || commitsNotOnTrunk < 0) {
      throw new Error(`git rev-list returned an invalid commit count for ${branch}`)
    }
    nameCheck = pullRequestNameCheck(
      project,
      input.pullRequests,
      branch,
      detail.tip,
      input.fetchedPullRequests,
    )
    const landedByName = nameCheck && 'pullRequest' in nameCheck && nameCheck.containsTip
    const nameCheckFailed = nameCheck && 'error' in nameCheck
    if (!landedByName && !nameCheckFailed && commitsNotOnTrunk > 0) {
      const mergeBase = git(project.path, 'merge-base', input.trunkTip, detail.tip)
      patchEquivalent = taskBranchPatchEquivalent({
        cwd: project.path,
        trunkTip: input.trunkTip,
        branchTip: detail.tip,
        mergeBase,
        commitMessage: `orch branch report ${branch}`,
      })
      const key = taskKeyToken(branch, project.settings.keyPrefixes ?? [])
      if (!patchEquivalent && key) {
        commitCheck = pullRequestCommitCheck(
          project,
          input.pullRequests.filter((pullRequest) => pullRequestCarriesKey(pullRequest, key)),
          detail.tip,
          input.fetchedPullRequests,
        )
      }
    }
  } catch (error) {
    checkError = error instanceof Error ? error.message : String(error)
  }
  return {
    branch,
    tip: detail.tip,
    commitsNotOnTrunk,
    checkedOut: input.checkedOut.has(branch),
    lastCommitAt: detail.lastCommitAt,
    remoteExists: input.remotes.has(branch),
    ...decideOtherBranchState({
      branch,
      mergedPullRequests: input.pullRequests,
      mergedPullRequestsTruncated: input.truncated,
      pullRequestNameCheck: nameCheck,
      commitsNotOnTrunk,
      patchEquivalent,
      pullRequestCommitCheck: commitCheck,
      checkError,
    }),
  }
}

function observationError(project: Project, error: unknown): BranchReportProject {
  const detail = error instanceof Error ? error.message : String(error)
  const fix = detail.startsWith('merged pull-request listing')
    ? 'install gh, run gh auth login, and configure a GitHub remote for this checkout'
    : detail.startsWith('git remote get-url origin')
      ? 'add an origin remote for this checkout, then rerun orch branches'
      : 'repair the registered checkout and trunk, then rerun orch branches'
  return {
    project: project.name,
    trunk: project.settings.trunk?.trim() ?? '',
    error: `${detail}; fix: ${fix}`,
    truncated: false,
    protected: [],
    keys: [],
  }
}

export function branchesReport(options: {
  project?: string
  key?: string
  allLocal?: boolean
}): BranchesReport {
  const selected = options.project === undefined ? null : projectByName(options.project)
  if (options.project !== undefined && !selected)
    throw new Error(`unknown project ${options.project}`)
  return {
    projects: (selected ? [selected] : projects()).map((project) => {
      try {
        return branchReportFor(project, options)
      } catch (error) {
        return observationError(project, error)
      }
    }),
  }
}

type BranchRunIdentity = { project_name: string; launch_key: string | null }

function branchRunIdentity(branch: string): {
  project: Project
  taskKey: string
} {
  const matches = db()
    .query(
      `SELECT DISTINCT p.name project_name,r.launch_key
         FROM run r
         JOIN project p ON p.id=r.project_id OR (r.project_id IS NULL AND p.name=r.repo)
        WHERE r.minted_branch=?`,
    )
    .all(branch) as BranchRunIdentity[]
  if (matches.length === 0) throw new Error(`branch ${branch} is not a recorded run branch`)
  if (matches.length !== 1) {
    throw new Error(`branch ${branch} belongs to more than one recorded project or task key`)
  }
  const match = matches[0]!
  if (!match.launch_key) throw new Error(`branch ${branch} has no recorded task key`)
  const project = projectByName(match.project_name)
  if (!project) throw new Error(`project ${match.project_name} is not active`)
  return { project, taskKey: match.launch_key }
}

function pullRequestLanding(project: Project, number: number): PullRequestLandingEvidence {
  const output = command(
    project.path,
    [
      'gh',
      'pr',
      'view',
      String(number),
      '--json',
      'number,state,title,headRefName,mergeCommit,mergedAt',
    ],
    `pull-request verification for PR #${number}`,
  )
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch (error) {
    throw new Error(
      `pull-request verification returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!isPullRequestLandingEvidence(value)) {
    throw new Error('pull-request verification returned an unexpected JSON shape')
  }
  return value
}

function isPullRequestLandingEvidence(value: unknown): value is PullRequestLandingEvidence {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  const mergeCommit = row.mergeCommit
  return (
    Number.isInteger(row.number) &&
    typeof row.state === 'string' &&
    typeof row.title === 'string' &&
    typeof row.headRefName === 'string' &&
    (typeof row.mergedAt === 'string' || row.mergedAt === null) &&
    (mergeCommit === null ||
      (typeof mergeCommit === 'object' &&
        mergeCommit !== null &&
        typeof (mergeCommit as Record<string, unknown>).oid === 'string'))
  )
}

export type RecordedLandingReport = {
  branch: string
  taskKey: string
  number: number
  mergeCommit: string | null
  mergedAt: string
  recordedAt: string
}

/** Verify GitHub's merged PR evidence, then persist one explicit landing row. */
export function recordBranchLanding(branch: string, number: number): RecordedLandingReport {
  if (!branch.trim()) throw new Error('branch must be non-empty')
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('PR number must be positive')
  writableDb()
  const { project, taskKey } = branchRunIdentity(branch)
  const verification = verifyBranchLanding(taskKey, pullRequestLanding(project, number))
  if (!verification.accepted) throw new Error(`refusing to record landing: ${verification.reason}`)
  const tip = git(project.path, 'rev-parse', '--verify', '--end-of-options', `${branch}^{commit}`)
  const recordedAt = nowIso()
  writeTransaction(() => {
    db()
      .query(
        `INSERT INTO branch_landing_record
           (project,branch,tip,pr_number,merge_commit,merged_at,recording_session,recorded_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(project,branch) DO UPDATE SET
           tip=excluded.tip, pr_number=excluded.pr_number, merge_commit=excluded.merge_commit,
           merged_at=excluded.merged_at, recording_session=excluded.recording_session,
           recorded_at=excluded.recorded_at`,
      )
      .run(
        project.name,
        branch,
        tip,
        verification.landing.number,
        verification.landing.mergeCommit,
        verification.landing.mergedAt,
        sessionId(),
        recordedAt,
      )
  })
  return { branch, taskKey, ...verification.landing, recordedAt }
}

function listOperatorBranch(row: BranchReportRow, report: BranchPruneReport): boolean {
  if (row.state !== 'unlanded' && row.state !== 'unknown') return false
  report.operator.push({
    branch: row.branch,
    state: row.state,
    commitsNotOnTrunk: row.commitsNotOnTrunk,
    command: `git branch -D ${row.branch}`,
  })
  report.kept.push({ branch: row.branch, reason: row.state })
  if (row.state === 'unknown' && row.error) report.errors.push(`${row.branch}: ${row.error}`)
  return true
}

function tipStillEligible(
  project: Project,
  row: BranchReportRow,
  report: BranchPruneReport,
): boolean {
  let currentTip: string | undefined
  try {
    currentTip = localBranches(project).get(row.branch)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    report.kept.push({
      branch: row.branch,
      reason: 'tip could not be rechecked',
    })
    report.errors.push(`${row.branch}: ${reason}`)
    return false
  }
  const eligibility = decidePruneEligibility({
    state: row.state,
    checkedOut: row.checkedOut,
    liveRun: row.liveRun,
    tipMoved: currentTip !== row.tip,
  })
  if (eligibility.eligible) return true
  report.kept.push({ branch: row.branch, reason: eligibility.reason })
  return false
}

function deleteAndSettleBranch(
  project: Project,
  row: BranchReportRow,
  report: BranchPruneReport,
): void {
  const trunk = project.settings.trunk?.trim() ?? ''
  const productionBranch = project.settings.productionBranch?.trim() ?? ''
  const protectedKind = decideProtectedBranch({
    branch: row.branch,
    trunk,
    productionBranch,
  })
  if (protectedKind !== null) {
    report.kept.push({
      branch: row.branch,
      reason: `registered ${protectedKind}`,
    })
    report.errors.push(`${row.branch}: refusing to delete registered ${protectedKind} branch`)
    return
  }
  try {
    writableDb()
    command(
      project.path,
      ['git', 'update-ref', '-d', `refs/heads/${row.branch}`, row.tip],
      `delete branch ${row.branch}`,
    )
    if (localBranches(project).has(row.branch)) {
      throw new Error('branch still exists after compare-at-tip deletion')
    }
    report.deleted.push(row.branch)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    report.kept.push({ branch: row.branch, reason: 'deletion failed' })
    report.errors.push(`${row.branch}: ${reason}`)
    return
  }
  try {
    settleDeletedBranch(project.name, row.branch)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    report.errors.push(`${row.branch}: branch deleted but claims could not be settled: ${reason}`)
  }
}

/** Observe once, then delete only branches whose safety facts still hold. */
export function pruneBranches(options: {
  project: string
  key: string
  dryRun?: boolean
}): BranchPruneReport {
  const observed = branchesReport({
    project: options.project,
    key: options.key,
  })
  const projectReport = observed.projects[0]!
  if (projectReport.error) throw new Error(projectReport.error)
  const project = projectByName(options.project)!
  const keyReport = projectReport.keys.find((candidate) => candidate.key === options.key)
  const report: BranchPruneReport = {
    project: options.project,
    key: options.key,
    allLocal: false,
    dryRun: options.dryRun ?? false,
    deleted: [],
    wouldDelete: [],
    kept: [],
    operator: [],
    errors: [],
  }
  for (const row of keyReport?.branches ?? []) {
    if (listOperatorBranch(row, report)) continue
    if (!tipStillEligible(project, row, report)) continue
    if (report.dryRun) {
      report.wouldDelete.push(row.branch)
      continue
    }
    deleteAndSettleBranch(project, row, report)
  }
  return report
}

/** Classify and prune every run-minted branch for one project through the ordinary prune path. */
export function pruneProjectBranches(options: {
  project: string
  dryRun?: boolean
}): BranchPruneReport {
  const observed = branchesReport({ project: options.project })
  const projectReport = observed.projects[0]!
  if (projectReport.error) throw new Error(projectReport.error)
  const project = projectByName(options.project)!
  const report: BranchPruneReport = {
    project: options.project,
    key: null,
    allLocal: false,
    dryRun: options.dryRun ?? false,
    deleted: [],
    wouldDelete: [],
    kept: [],
    operator: [],
    errors: [],
  }
  const seen = new Set<string>()
  for (const row of projectReport.keys.flatMap((key) => key.branches)) {
    if (seen.has(row.branch)) continue
    seen.add(row.branch)
    if (listOperatorBranch(row, report)) continue
    if (!tipStillEligible(project, row, report)) continue
    if (report.dryRun) report.wouldDelete.push(row.branch)
    else deleteAndSettleBranch(project, row, report)
  }
  return report
}

/** Return the ordinary prune classifier's state for one recorded run branch. */
export function classifyMintedBranch(project: string, branch: string): BranchStateDecision {
  const observed = branchesReport({ project })
  const projectReport = observed.projects[0]!
  if (projectReport.error) return { state: 'unknown', error: projectReport.error }
  return (
    projectReport.keys.flatMap((key) => key.branches).find((row) => row.branch === branch) ?? {
      state: 'unknown',
      error: `branch ${branch} is not an existing orch-minted branch in project ${project}`,
    }
  )
}

function listOtherOperator(row: OtherBranchReportRow, report: BranchPruneReport): void {
  if (row.state === 'unlanded' || row.state === 'unknown') {
    report.operator.push({
      branch: row.branch,
      state: row.state,
      commitsNotOnTrunk: row.commitsNotOnTrunk,
      command: `git branch -D ${row.branch}`,
    })
    if (row.state === 'unknown' && row.error) report.errors.push(`${row.branch}: ${row.error}`)
  }
}

function otherTipStillEligible(
  project: Project,
  row: OtherBranchReportRow,
  report: BranchPruneReport,
): boolean {
  let currentTip: string | undefined
  try {
    currentTip = localBranches(project).get(row.branch)
  } catch (error) {
    report.kept.push({
      branch: row.branch,
      reason: 'tip could not be rechecked',
    })
    report.errors.push(`${row.branch}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  const protectedKind = decideProtectedBranch({
    branch: row.branch,
    trunk: project.settings.trunk?.trim() ?? '',
    productionBranch: project.settings.productionBranch?.trim() ?? '',
  })
  const eligibility = decideOtherPruneEligibility({
    state: row.state,
    held: isHeldBranch(row.branch),
    checkedOut: row.checkedOut,
    protectedKind,
    tipMoved: currentTip !== row.tip,
  })
  if (eligibility.eligible) return true
  report.kept.push({
    branch: row.branch,
    reason: protectedKind ? `registered ${protectedKind}` : eligibility.reason,
  })
  if (protectedKind) {
    report.errors.push(`${row.branch}: refusing to delete registered ${protectedKind} branch`)
  }
  listOtherOperator(row, report)
  return false
}

function deleteOtherBranch(
  project: Project,
  row: OtherBranchReportRow,
  report: BranchPruneReport,
): void {
  try {
    command(
      project.path,
      ['git', 'update-ref', '-d', `refs/heads/${row.branch}`, row.tip],
      `delete branch ${row.branch}`,
    )
    if (localBranches(project).has(row.branch)) {
      throw new Error('branch still exists after compare-at-tip deletion')
    }
    report.deleted.push(row.branch)
  } catch (error) {
    report.kept.push({ branch: row.branch, reason: 'deletion failed' })
    report.errors.push(`${row.branch}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Observe once, then compare-at-tip delete eligible non-run local branches. */
export function pruneOtherBranches(options: {
  project: string
  dryRun?: boolean
}): BranchPruneReport {
  const observed = branchesReport({ project: options.project, allLocal: true })
  const projectReport = observed.projects[0]!
  if (projectReport.error) throw new Error(projectReport.error)
  const project = projectByName(options.project)!
  const report: BranchPruneReport = {
    project: options.project,
    key: null,
    allLocal: true,
    dryRun: options.dryRun ?? false,
    deleted: [],
    wouldDelete: [],
    kept: [],
    operator: [],
    errors: [],
  }
  for (const row of projectReport.other ?? []) {
    if (!otherTipStillEligible(project, row, report)) continue
    if (report.dryRun) {
      report.wouldDelete.push(row.branch)
      continue
    }
    deleteOtherBranch(project, row, report)
  }
  return report
}

function landedByText(row: BranchStateDecision | OtherBranchLanding): string {
  if (row.state !== 'landed') return row.state
  if (row.landedBy.type === 'patch-equivalent') {
    return `landed (patch-equivalent ${row.landedBy.form})`
  }
  if (row.landedBy.type === 'turn') return `landed (turn ${row.landedBy.branch})`
  if (row.landedBy.type === 'pr-commits') return `landed (PR #${row.landedBy.number} commits)`
  if (row.landedBy.type === 'recorded') {
    return `landed (recorded PR #${row.landedBy.number}, merge ${row.landedBy.mergeCommit ?? 'none'}, ${row.landedBy.mergedAt})`
  }
  return `landed (PR #${row.landedBy.number}, merge ${row.landedBy.mergeCommit ?? 'none'}, ${row.landedBy.mergedAt})`
}

export function renderBranchesReport(report: BranchesReport): string {
  return report.projects.flatMap(renderProject).join('\n')
}

export function renderBranchPruneReport(report: BranchPruneReport): string {
  const action = report.dryRun ? 'would delete' : 'deleted'
  const acted = report.dryRun ? report.wouldDelete : report.deleted
  const lines = [
    `${report.project} ${report.allLocal ? 'other' : report.key}: ${action} ${acted.length}; kept ${report.kept.length}`,
  ]
  for (const branch of acted) lines.push(`  ${action}: ${branch}`)
  for (const row of report.kept) lines.push(`  kept: ${row.branch} (${row.reason})`)
  for (const row of report.operator) {
    lines.push(
      `  operator: ${row.branch} (${row.state}, ${row.commitsNotOnTrunk} commits not on trunk); ${row.command}`,
    )
  }
  for (const error of report.errors) lines.push(`  ERROR: ${error}`)
  return lines.join('\n')
}

function renderProject(project: BranchReportProject): string[] {
  const lines = [`${project.project} (trunk ${project.trunk || 'not configured'})`]
  if (project.error) return [...lines, `  ERROR: ${project.error}`]
  if (project.truncated) {
    lines.push(`  merged PR listing reached ${GH_MERGED_PR_LIMIT}; unmatched branches are unknown`)
  }
  for (const row of project.protected) {
    lines.push(`  protected: ${row.branch}  runs ${row.runIds.join(',')}`)
  }
  if (project.keys.length === 0 && project.protected.length === 0)
    lines.push('  no run-minted local branches')
  for (const key of project.keys) {
    lines.push(`  ${key.key}`)
    lines.push(...key.branches.map(renderBranch))
  }
  if (project.other) {
    lines.push('  other')
    if (project.other.length === 0) lines.push('    no other local branches')
    else lines.push(...project.other.map(renderOtherBranch))
  }
  return lines
}

function renderBranch(branch: BranchReportRow): string {
  const state =
    branch.state === 'unknown' && branch.error ? `unknown (${branch.error})` : landedByText(branch)
  const note = branch.note ? `  ${branch.note}` : ''
  return `    ${branch.branch}  ${state}${note}  tip ${branch.tip}  commits-not-on-trunk ${branch.commitsNotOnTrunk}  checked-out ${branch.checkedOut ? 'yes' : 'no'}  live-run ${branch.liveRun ? 'yes' : 'no'}  runs ${branch.runIds.join(',')}`
}

function renderOtherBranch(branch: OtherBranchReportRow): string {
  const state =
    branch.state === 'unknown' && branch.error ? `unknown (${branch.error})` : landedByText(branch)
  return `    ${branch.branch}  ${state}  tip ${branch.tip}  commits-not-on-trunk ${branch.commitsNotOnTrunk}  checked-out ${branch.checkedOut ? 'yes' : 'no'}  last-commit-at ${branch.lastCommitAt}  origin ${branch.remoteExists ? 'yes' : 'no'}`
}
