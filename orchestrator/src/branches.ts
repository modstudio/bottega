// concern: branches
/** Observes registered projects and assembles the run-minted branch report. */

import { settleDeletedBranch } from './branch-settlement.ts'
import {
  type BranchLanding,
  decideBranchState,
  decidePruneEligibility,
  type MergedPullRequest,
  type PatchEquivalentForm,
  type PullRequestCommitCheck,
  pullRequestCarriesKey,
} from './branch-state.ts'
import { db, writableDb } from './db.ts'
import { targetGitEnvironment } from './git-environment.ts'
import type { Project } from './projects.ts'
import { projectByName, projects } from './projects.ts'
import {
  isTaskBranchSuperseded,
  type TaskBranchRunRow,
  taskBranchPatchEquivalent,
} from './task-branch.ts'

const GH_MERGED_PR_LIMIT = 1000

type RunRow = {
  id: number
  parent_run_id: number | null
  launch_key: string | null
  branch: string | null
  minted_branch: string | null
  launch_base: string | null
  status: string
}

type BranchReportRow = BranchLanding & {
  branch: string
  tip: string
  commitsNotOnTrunk: number
  checkedOut: boolean
  liveRun: boolean
  runIds: number[]
}

type BranchReportProject = {
  project: string
  trunk: string
  error?: string
  truncated: boolean
  keys: { key: string; branches: BranchReportRow[] }[]
}

export type BranchesReport = { projects: BranchReportProject[] }

type BranchPruneReport = {
  project: string
  key: string
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

function command(cwd: string, argv: string[], label: string): string {
  let process: ReturnType<typeof Bun.spawnSync>
  try {
    process = Bun.spawnSync(argv, {
      cwd,
      env: targetGitEnvironment(cwd),
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

function mergedPullRequests(project: Project): {
  pullRequests: MergedPullRequest[]
  truncated: boolean
} {
  const output = command(
    project.path,
    [
      'gh',
      'pr',
      'list',
      '--state',
      'merged',
      '--limit',
      String(GH_MERGED_PR_LIMIT),
      '--json',
      'number,headRefName,headRefOid,title,mergeCommit,mergedAt',
    ],
    'merged pull-request listing',
  )
  let value: unknown
  try {
    value = JSON.parse(output || '[]')
  } catch (error) {
    throw new Error(
      `merged pull-request listing returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!Array.isArray(value) || !value.every(isMergedPullRequest)) {
    throw new Error('merged pull-request listing returned an unexpected JSON shape')
  }
  return { pullRequests: value, truncated: value.length === GH_MERGED_PR_LIMIT }
}

function isMergedPullRequest(value: unknown): value is MergedPullRequest {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  const mergeCommit = row.mergeCommit
  return (
    Number.isInteger(row.number) &&
    typeof row.headRefName === 'string' &&
    typeof row.headRefOid === 'string' &&
    typeof row.title === 'string' &&
    typeof row.mergedAt === 'string' &&
    (mergeCommit === null ||
      (typeof mergeCommit === 'object' &&
        mergeCommit !== null &&
        typeof (mergeCommit as Record<string, unknown>).oid === 'string'))
  )
}

function fetchPullRequest(project: Project, pullRequest: MergedPullRequest): string | null {
  try {
    git(project.path, 'fetch', '--no-tags', 'origin', pullRequest.headRefOid)
    return null
  } catch (shaError) {
    try {
      git(project.path, 'fetch', '--no-tags', 'origin', `refs/pull/${pullRequest.number}/head`)
      return null
    } catch (refError) {
      return `PR #${pullRequest.number} fetch failed by SHA (${String(shaError)}) and pull ref (${String(refError)})`
    }
  }
}

function pullRequestCommitCheck(
  project: Project,
  pullRequests: readonly MergedPullRequest[],
  branchTip: string,
  fetched: Map<number, string | null>,
): PullRequestCommitCheck {
  let failure: string | null = null
  for (const pullRequest of pullRequests) {
    let fetchFailure = fetched.get(pullRequest.number)
    if (fetchFailure === undefined) {
      fetchFailure = fetchPullRequest(project, pullRequest)
      fetched.set(pullRequest.number, fetchFailure)
    }
    if (fetchFailure) {
      failure ??= fetchFailure
      continue
    }
    try {
      const cherry = git(project.path, 'cherry', pullRequest.headRefOid, branchTip)
      if (!cherry.split('\n').some((line) => line.startsWith('+'))) {
        return { number: pullRequest.number }
      }
    } catch (error) {
      failure ??= `PR #${pullRequest.number} commit check failed: ${String(error)}`
    }
  }
  return failure ? { error: failure } : null
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
  const rows = git(
    project.path,
    'for-each-ref',
    '--format=%(refname:short)%09%(objectname)',
    'refs/heads',
  )
  const branches = new Map<string, string>()
  for (const line of rows.split('\n')) {
    if (!line) continue
    const tab = line.indexOf('\t')
    if (tab < 1) throw new Error(`git for-each-ref returned an unexpected row: ${line}`)
    branches.set(line.slice(0, tab), line.slice(tab + 1))
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

function branchReportFor(project: Project, keyFilter?: string): BranchReportProject {
  const trunk = project.settings.trunk?.trim() ?? ''
  if (!trunk) throw new Error(`project ${project.name} has no trunk configured`)
  git(project.path, 'remote', 'get-url', 'origin')
  const { pullRequests: listedPullRequests, truncated } = mergedPullRequests(project)
  const pullRequests = listedPullRequests.sort((left, right) =>
    right.mergedAt.localeCompare(left.mergedAt),
  )
  const fetchedPullRequests = new Map<number, string | null>()
  const runs = projectRuns(project)
  const branches = localBranches(project)
  const checkedOut = checkedOutBranches(project)
  const trunkTip = git(
    project.path,
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${trunk}^{commit}`,
  )
  const minted = new Map<string, Map<string, RunRow[]>>()
  for (const run of runs) {
    if (!run.minted_branch || !branches.has(run.minted_branch)) continue
    const key = run.launch_key ?? 'unkeyed'
    if (keyFilter !== undefined && key !== keyFilter) continue
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
            !matchingPr && commitCount > 0 && !patchEquivalent
              ? pullRequestCommitCheck(
                  project,
                  pullRequests.filter((pullRequest) => pullRequestCarriesKey(pullRequest, key)),
                  tip,
                  fetchedPullRequests,
                )
              : null,
          superseded: isTaskBranchSuperseded(branch, keyRows),
          turns: new Map(branchRuns.map((run) => [run.parent_run_id ?? run.id, run.id] as const)),
        }
      })
      const decided = new Map<string, BranchLanding>()
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
            mergedPullRequests: pullRequests,
            mergedPullRequestsTruncated: truncated,
            commitsNotOnTrunk: row.commitsNotOnTrunk,
            patchEquivalent: row.patchEquivalent,
            pullRequestCommitCheck: row.pullRequestCommitCheck,
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
            superseded: _superseded,
            turns: _turns,
            ...row
          }) => ({ ...row, ...decided.get(row.branch)! }) satisfies BranchReportRow,
        )
      return { key, branches: reportBranches }
    })
  return { project: project.name, trunk, truncated, keys }
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
    keys: [],
  }
}

export function branchesReport(options: { project?: string; key?: string }): BranchesReport {
  const selected = options.project === undefined ? null : projectByName(options.project)
  if (options.project !== undefined && !selected)
    throw new Error(`unknown project ${options.project}`)
  return {
    projects: (selected ? [selected] : projects()).map((project) => {
      try {
        return branchReportFor(project, options.key)
      } catch (error) {
        return observationError(project, error)
      }
    }),
  }
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
    report.kept.push({ branch: row.branch, reason: 'tip could not be rechecked' })
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
  const observed = branchesReport({ project: options.project, key: options.key })
  const projectReport = observed.projects[0]!
  if (projectReport.error) throw new Error(projectReport.error)
  const project = projectByName(options.project)!
  const keyReport = projectReport.keys.find((candidate) => candidate.key === options.key)
  const report: BranchPruneReport = {
    project: options.project,
    key: options.key,
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

function landedByText(row: BranchReportRow): string {
  if (row.state !== 'landed') return row.state
  if (row.landedBy.type === 'patch-equivalent') {
    return `landed (patch-equivalent ${row.landedBy.form})`
  }
  if (row.landedBy.type === 'turn') return `landed (turn ${row.landedBy.branch})`
  if (row.landedBy.type === 'pr-commits') return `landed (PR #${row.landedBy.number} commits)`
  return `landed (PR #${row.landedBy.number}, merge ${row.landedBy.mergeCommit ?? 'none'}, ${row.landedBy.mergedAt})`
}

export function renderBranchesReport(report: BranchesReport): string {
  return report.projects.flatMap(renderProject).join('\n')
}

export function renderBranchPruneReport(report: BranchPruneReport): string {
  const action = report.dryRun ? 'would delete' : 'deleted'
  const acted = report.dryRun ? report.wouldDelete : report.deleted
  const lines = [
    `${report.project} ${report.key}: ${action} ${acted.length}; kept ${report.kept.length}`,
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
  if (project.keys.length === 0) lines.push('  no run-minted local branches')
  for (const key of project.keys) {
    lines.push(`  ${key}`)
    lines.push(...key.branches.map(renderBranch))
  }
  return lines
}

function renderBranch(branch: BranchReportRow): string {
  const state =
    branch.state === 'unknown' && branch.error ? `unknown (${branch.error})` : landedByText(branch)
  return `    ${branch.branch}  ${state}  tip ${branch.tip}  commits-not-on-trunk ${branch.commitsNotOnTrunk}  checked-out ${branch.checkedOut ? 'yes' : 'no'}  live-run ${branch.liveRun ? 'yes' : 'no'}  runs ${branch.runIds.join(',')}`
}
