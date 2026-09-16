// concern: branches
/** Observes registered projects and assembles the run-minted branch report. */

import { type BranchLanding, decideBranchState, type MergedPullRequest } from './branch-state.ts'
import { db } from './db.ts'
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
  return { pullRequests: value, truncated: value.length === GH_MERGED_PR_LIMIT }
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
      const reportBranches = [...byBranch]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([branch, branchRuns]): BranchReportRow => {
          const tip = branches.get(branch)!
          const commitCount = Number(
            git(project.path, 'rev-list', '--count', tip, '--not', trunkTip),
          )
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
          const state = decideBranchState({
            branch,
            mergedPullRequests: pullRequests,
            mergedPullRequestsTruncated: truncated,
            commitsNotOnTrunk: commitCount,
            patchEquivalent,
            superseded: isTaskBranchSuperseded(branch, keyRows),
          })
          return {
            branch,
            tip,
            commitsNotOnTrunk: commitCount,
            checkedOut: checkedOut.has(branch),
            liveRun: branchRuns.some((run) => run.status === 'running' || run.status === 'asking'),
            runIds: branchRuns.map((run) => run.id),
            ...state,
          }
        })
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

function landedByText(row: BranchReportRow): string {
  if (row.state !== 'landed') return row.state
  if (row.landedBy.type === 'patch-equivalent') {
    return `landed (patch-equivalent ${row.landedBy.form})`
  }
  return `landed (PR #${row.landedBy.number}, merge ${row.landedBy.mergeCommit ?? 'none'}, ${row.landedBy.mergedAt})`
}

export function renderBranchesReport(report: BranchesReport): string {
  return report.projects.flatMap(renderProject).join('\n')
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
  return `    ${branch.branch}  ${landedByText(branch)}  tip ${branch.tip}  commits-not-on-trunk ${branch.commitsNotOnTrunk}  checked-out ${branch.checkedOut ? 'yes' : 'no'}  live-run ${branch.liveRun ? 'yes' : 'no'}  runs ${branch.runIds.join(',')}`
}
