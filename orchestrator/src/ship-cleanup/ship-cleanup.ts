// concern: ship cleanup
/** Gathers branch cleanup facts and composes artifact removal, close-out, and branch prune. */

import type { Database } from 'bun:sqlite'
import { rmSync } from 'node:fs'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { findRecordedBranchLanding } from '../branch/branch-state.ts'
import { classifyMintedBranch, pruneBranches } from '../branch/branches.ts'
import { closeOutRun } from '../close/close-out.ts'
import { writableDb } from '../database/db.ts'
import { measureStoragePaths } from '../monitor/storage-report.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import { runArtifactsDir, runScratchDir } from '../run/run-artifacts.ts'
import { decideShipCleanup, type ShipCleanupRunFact } from './ship-cleanup-decision.ts'

type RunRow = {
  id: number
  parent_run_id: number | null
  job: string
  status: string
  branch: string | null
  launch_key: string | null
  evidence_excluded: string | null
  worktree: string | null
}

export type ShipCleanupReport = {
  project: string
  branch: string
  freed: { artifacts: number; scratch: number; worktrees: number }
  removed: { artifacts: number[]; scratch: number[]; worktrees: string[]; branches: string[] }
  kept: { item: string; reason: string; remedy?: string }[]
  errors: { item: string; detail: string; retry: string }[]
}

export type ShipCleanupDependencies = {
  landingState(project: string, branch: string): string
  closeOut(runId: number): { outcome: string; detail: string }
  prune(
    project: string,
    branch: string,
    key: string,
  ): {
    deleted: string[]
    kept: { branch: string; reason: string }[]
    errors: string[]
  }
  measure(paths: readonly string[]): { bytes: number; errors: string[]; stoppedAtLimit: boolean }
  remove(path: string): void
}

const dependencies: ShipCleanupDependencies = {
  landingState: (project, branch) => classifyMintedBranch(project, branch).state,
  closeOut: (runId) => closeOutRun(runId, { intent: 'explicit' }),
  prune: (project, branch, key) => pruneBranches({ project, key, branch }),
  measure: measureStoragePaths,
  remove: (path) => rmSync(path, { recursive: true, force: true }),
}

function runFacts(projectRecordId: string, database: Database): ShipCleanupRunFact[] {
  const rows = database
    .query(
      `SELECT id,parent_run_id,job,status,branch,launch_key,evidence_excluded,worktree
         FROM run WHERE project_record_id=? ORDER BY id`,
    )
    .all(projectRecordId) as RunRow[]
  const scored = new Set(
    (
      database
        .query(
          `SELECT score.run_id FROM score JOIN run ON run.id=score.run_id
            WHERE run.project_record_id=?`,
        )
        .all(projectRecordId) as { run_id: number }[]
    ).map((row) => row.run_id),
  )
  const excludedRoots = new Set(
    rows.filter((row) => row.evidence_excluded !== null).map((row) => row.parent_run_id ?? row.id),
  )
  return rows.map((row) => {
    const rootId = row.parent_run_id ?? row.id
    return {
      id: row.id,
      rootId,
      job: row.job,
      status: row.status,
      branch: row.branch,
      launchKey: row.launch_key,
      judged: scored.has(rootId) || excludedRoots.has(rootId),
      worktree: row.worktree,
    }
  })
}

function recordedLanding(project: string, branch: string, database: Database): boolean {
  const records = database
    .query(
      `SELECT project,branch,tip,pr_number AS number,merge_commit AS mergeCommit,merged_at AS mergedAt
         FROM branch_landing_record WHERE project=? AND branch=?`,
    )
    .all(project, branch) as Array<{
    project: string
    branch: string
    tip: string
    number: number
    mergeCommit: string | null
    mergedAt: string
  }>
  return findRecordedBranchLanding(records, project, branch) !== null
}

function removalBytes(
  paths: readonly string[],
  adapter: ShipCleanupDependencies,
): { before: number; after: number; errors: string[] } {
  const before = adapter.measure(paths)
  for (const path of paths) adapter.remove(path)
  const after = adapter.measure(paths)
  const errors = [...before.errors, ...after.errors]
  if (before.stoppedAtLimit || after.stoppedAtLimit)
    errors.push('storage walk stopped at its entry cap')
  return { before: before.bytes, after: after.bytes, errors }
}

export function shipCleanup(
  branch: string,
  options: {
    cwd?: string
    project?: string
    confirmedLanded?: boolean
    database?: Database
    dependencies?: ShipCleanupDependencies
  } = {},
): ShipCleanupReport {
  const database = options.database ?? writableDb()
  const project = options.project
    ? projectByName(options.project, database)
    : projectAt(options.cwd ?? process.cwd(), database)
  if (!project) {
    throw new Error(
      `cannot resolve a project for ship cleanup; run ${PLATFORM_SLUG} tree ship-cleanup ${branch} from a registered checkout`,
    )
  }
  const adapter = options.dependencies ?? dependencies
  if (
    !options.confirmedLanded &&
    !recordedLanding(project.name, branch, database) &&
    adapter.landingState(project.name, branch) !== 'landed'
  ) {
    throw new Error(
      `refusing ship cleanup: branch ${branch} has not been confirmed landed; cleared by: ${PLATFORM_SLUG} pr merge ${branch}`,
    )
  }
  const decisions = decideShipCleanup(branch, runFacts(project.recordId, database))
  const report: ShipCleanupReport = {
    project: project.name,
    branch,
    freed: { artifacts: 0, scratch: 0, worktrees: 0 },
    removed: { artifacts: [], scratch: [], worktrees: [], branches: [] },
    kept: [],
    errors: [],
  }
  const removable = decisions.filter((decision) => decision.artifacts === 'remove')
  for (const kind of ['artifacts', 'scratch'] as const) {
    const paths = removable.map((run) =>
      kind === 'artifacts' ? runArtifactsDir(run.id) : runScratchDir(run.id),
    )
    try {
      const measured = removalBytes(paths, adapter)
      report.freed[kind] = Math.max(0, measured.before - measured.after)
      report.removed[kind].push(...removable.map((run) => run.id))
      for (const detail of measured.errors) {
        report.errors.push({
          item: kind,
          detail,
          retry: `${PLATFORM_SLUG} tree ship-cleanup ${branch}`,
        })
      }
    } catch (cause) {
      report.errors.push({
        item: kind,
        detail: cause instanceof Error ? cause.message : String(cause),
        retry: `${PLATFORM_SLUG} tree ship-cleanup ${branch}`,
      })
    }
  }
  for (const decision of decisions) {
    if (decision.scope === 'outside') continue
    if (decision.artifacts === 'keep') {
      report.kept.push({
        item:
          `run ${decision.id} artifacts and scratch` +
          (decision.worktreeAction === 'keep' && decision.worktree ? ' and worktree' : ''),
        reason: decision.reason,
        ...(!decision.judged && decision.worktreeAction === 'close'
          ? { remedy: `${PLATFORM_SLUG} score ${decision.rootId}` }
          : {}),
      })
    }
  }
  const closeRows = decisions.filter(
    (decision) => decision.worktreeAction === 'close' && decision.worktree,
  )
  const worktrees = [...new Set(closeRows.flatMap((row) => (row.worktree ? [row.worktree] : [])))]
  const worktreeBefore = adapter.measure(worktrees)
  const closedRoots = new Set<number>()
  for (const row of closeRows) {
    if (closedRoots.has(row.rootId)) continue
    closedRoots.add(row.rootId)
    try {
      const result = adapter.closeOut(row.id)
      if (result.outcome === 'released' || result.outcome === 'absent') {
        if (row.worktree) report.removed.worktrees.push(row.worktree)
      } else {
        report.kept.push({ item: `run ${row.id} worktree`, reason: result.detail })
        report.errors.push({
          item: `run ${row.id} worktree`,
          detail: `close-out ${result.outcome}: ${result.detail}`,
          retry: `${PLATFORM_SLUG} tree ship-cleanup ${branch}`,
        })
      }
    } catch (cause) {
      report.errors.push({
        item: `run ${row.id} worktree`,
        detail: cause instanceof Error ? cause.message : String(cause),
        retry: `${PLATFORM_SLUG} tree ship-cleanup ${branch}`,
      })
    }
  }
  const worktreeAfter = adapter.measure(worktrees)
  report.freed.worktrees = Math.max(0, worktreeBefore.bytes - worktreeAfter.bytes)
  try {
    const key = decisions.find((decision) => decision.scope !== 'outside')?.launchKey
    if (!key) throw new Error(`no task-attributed run records branch ${branch}`)
    const pruned = adapter.prune(project.name, branch, key)
    report.removed.branches.push(...pruned.deleted)
    report.kept.push(
      ...pruned.kept.map((item) => ({ item: `branch ${item.branch}`, reason: item.reason })),
    )
    report.errors.push(
      ...pruned.errors.map((detail) => ({
        item: `branch ${branch}`,
        detail,
        retry: `${PLATFORM_SLUG} tree ship-cleanup ${branch}`,
      })),
    )
  } catch (cause) {
    report.errors.push({
      item: `branch ${branch}`,
      detail: cause instanceof Error ? cause.message : String(cause),
      retry: `${PLATFORM_SLUG} tree ship-cleanup ${branch}`,
    })
  }
  return report
}

export function formatShipCleanup(report: ShipCleanupReport): string {
  const lines = [
    `ship cleanup ${report.project}/${report.branch}`,
    `freed: artifacts ${report.freed.artifacts} bytes; scratch ${report.freed.scratch} bytes; worktrees ${report.freed.worktrees} bytes`,
  ]
  for (const item of report.kept) {
    lines.push(
      `kept: ${item.item}: ${item.reason}${item.remedy ? `; cleared by: ${item.remedy}` : ''}`,
    )
  }
  for (const error of report.errors) {
    lines.push(`failed: ${error.item}: ${error.detail}; retry: ${error.retry}`)
  }
  if (!report.kept.length && !report.errors.length) lines.push('kept: none')
  return lines.join('\n')
}
