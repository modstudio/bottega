// concern: branches
/** Observes registered projects and assembles the run-minted branch report. */

import { type PullRequestLandingEvidence, verifyBranchLanding } from './branch-landing-record.ts'
import { settleDeletedBranch } from './branch-settlement.ts'
import {
  type BranchLanding,
  decideBranchState,
  decidePruneEligibility,
  type MergedPullRequest,
  type PatchEquivalentForm,
  type RecordedBranchLanding,
} from './branch-state.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from './db.ts'
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

type BranchLandingRecordRow = {
  branch: string
  pr_number: number
  merge_commit: string | null
  merged_at: string
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

/** Git versions before merge-tree --write-tree leave this fact unknown. */
function branchWorkContained(cwd: string, trunkTip: string, branchTip: string): boolean | null {
  let help: ReturnType<typeof Bun.spawnSync>
  try {
    help = Bun.spawnSync(['git', 'merge-tree', '-h'], {
      cwd,
      env: targetGitEnvironment(cwd),
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (error) {
    throw new Error(
      `git merge-tree capability check failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const usage = `${help.stdout?.toString() ?? ''}\n${help.stderr?.toString() ?? ''}`
  if (!usage.includes('--write-tree')) return null

  let merge: ReturnType<typeof Bun.spawnSync>
  try {
    merge = Bun.spawnSync(['git', 'merge-tree', '--write-tree', trunkTip, branchTip], {
      cwd,
      env: targetGitEnvironment(cwd),
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (error) {
    throw new Error(
      `git merge-tree --write-tree failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (merge.exitCode !== 0) return false
  const mergedTree = merge.stdout?.toString().trim().split('\n')[0] ?? ''
  return mergedTree === git(cwd, 'rev-parse', `${trunkTip}^{tree}`)
}

function recordedBranchLandings(): Map<string, RecordedBranchLanding> {
  const rows = db()
    .query(
      'SELECT branch,pr_number,merge_commit,merged_at FROM branch_landing_record ORDER BY branch',
    )
    .all() as BranchLandingRecordRow[]
  return new Map(
    rows.map((row) => [
      row.branch,
      {
        number: row.pr_number,
        mergeCommit: row.merge_commit,
        mergedAt: row.merged_at,
      },
    ]),
  )
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
      'number,headRefName,mergeCommit,mergedAt',
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
  return {
    pullRequests: value,
    truncated: value.length === GH_MERGED_PR_LIMIT,
  }
}

function isMergedPullRequest(value: unknown): value is MergedPullRequest {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  const mergeCommit = row.mergeCommit
  return (
    Number.isInteger(row.number) &&
    typeof row.headRefName === 'string' &&
    typeof row.mergedAt === 'string' &&
    (mergeCommit === null ||
      (typeof mergeCommit === 'object' &&
        mergeCommit !== null &&
        typeof (mergeCommit as Record<string, unknown>).oid === 'string'))
  )
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
  const { pullRequests, truncated } = mergedPullRequests(project)
  const runs = projectRuns(project)
  const branches = localBranches(project)
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
        const contained = commitCount > 0 ? branchWorkContained(project.path, trunkTip, tip) : false
        return {
          branch,
          tip,
          commitsNotOnTrunk: commitCount,
          checkedOut: checkedOut.has(branch),
          liveRun: branchRuns.some((run) => run.status === 'running' || run.status === 'asking'),
          runIds: branchRuns.map((run) => run.id),
          patchEquivalent: patchEquivalent as PatchEquivalentForm | null,
          contained,
          recordedLanding: recordedLandings.get(branch) ?? null,
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
            contained: row.contained,
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
            contained: _contained,
            recordedLanding: _recordedLanding,
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
    ['gh', 'pr', 'view', String(number), '--json', 'number,state,title,mergeCommit,mergedAt'],
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
  const recordedAt = nowIso()
  writeTransaction(() => {
    db()
      .query(
        `INSERT INTO branch_landing_record
           (branch,pr_number,merge_commit,merged_at,recording_session,recorded_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        branch,
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
  if (row.landedBy.type === 'contained') return 'landed (contained)'
  if (row.landedBy.type === 'turn') return `landed (turn ${row.landedBy.branch})`
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
    lines.push(`  ${key.key}`)
    lines.push(...key.branches.map(renderBranch))
  }
  return lines
}

function renderBranch(branch: BranchReportRow): string {
  return `    ${branch.branch}  ${landedByText(branch)}  tip ${branch.tip}  commits-not-on-trunk ${branch.commitsNotOnTrunk}  checked-out ${branch.checkedOut ? 'yes' : 'no'}  live-run ${branch.liveRun ? 'yes' : 'no'}  runs ${branch.runIds.join(',')}`
}
