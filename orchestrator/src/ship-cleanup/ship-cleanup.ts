// concern: ship cleanup
/** Gathers branch cleanup facts and composes artifact removal, close-out, and branch prune. */

import type { Database } from 'bun:sqlite'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { findRecordedBranchLanding } from '../branch/branch-state.ts'
import { classifyMintedBranch, pruneBranch } from '../branch/branches.ts'
import { closeOutRun } from '../close/close-out.ts'
import { writableDb } from '../database/db.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import { runArtifactsDir, runScratchDir } from '../run/run-artifacts.ts'
import { STORAGE_WALK_ENTRY_LIMIT, walkStoragePaths } from '../storage-walk.ts'
import {
  decideShipCleanup,
  type ShipCleanupRunDecision,
  type ShipCleanupRunFact,
} from './ship-cleanup-decision.ts'

type RunRow = {
  id: number
  parent_run_id: number | null
  started_at: string
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
  ): {
    deleted: string[]
    kept: { branch: string; reason: string }[]
    errors: string[]
  }
  measure(paths: readonly string[]): { bytes: number; errors: string[]; stoppedAtLimit: boolean }
  readerCloneArchive(runId: number): string | null
  remove(path: string): void
}

const dependencies: ShipCleanupDependencies = {
  landingState: (project, branch) => classifyMintedBranch(project, branch).state,
  closeOut: (runId) => closeOutRun(runId, { intent: 'explicit' }),
  prune: (project, branch) => pruneBranch({ project, branch }),
  measure: (paths) => {
    const walked = walkStoragePaths(paths, () => ({}), STORAGE_WALK_ENTRY_LIMIT)
    return {
      bytes: walked.observations.reduce((total, entry) => total + entry.bytes, 0),
      errors: walked.unreadable ? [...walked.errors, walked.unreadable] : walked.errors,
      stoppedAtLimit: walked.stoppedAtLimit,
    }
  },
  readerCloneArchive: (runId) => {
    try {
      const value = JSON.parse(
        readFileSync(join(runArtifactsDir(runId), 'reader-clone-archive.json'), 'utf8'),
      ) as { path?: unknown }
      return typeof value.path === 'string' ? value.path : null
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw cause
    }
  },
  remove: (path) => rmSync(path, { recursive: true, force: true }),
}

function runFacts(projectRecordId: string, database: Database): ShipCleanupRunFact[] {
  const rows = database
    .query(
      `SELECT id,parent_run_id,started_at,job,status,branch,launch_key,evidence_excluded,worktree
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
      startedAt: row.started_at,
      job: row.job,
      status: row.status,
      branch: row.branch,
      launchKey: row.launch_key,
      judged: scored.has(rootId) || excludedRoots.has(rootId),
      worktree: row.worktree,
    }
  })
}

function recordedLanding(project: string, branch: string, database: Database): string | null {
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
  return findRecordedBranchLanding(records, project, branch)?.mergedAt ?? null
}

function emptyReport(project: string, branch: string): ShipCleanupReport {
  return {
    project,
    branch,
    freed: { artifacts: 0, scratch: 0, worktrees: 0 },
    removed: { artifacts: [], scratch: [], worktrees: [], branches: [] },
    kept: [],
    errors: [],
  }
}

function cleanupRetry(branch: string): string {
  return `${PLATFORM_SLUG} tree ship-cleanup ${branch}`
}

function reportMeasurementErrors(
  branch: string,
  item: string,
  measurement: ReturnType<ShipCleanupDependencies['measure']>,
  report: ShipCleanupReport,
): void {
  for (const detail of measurement.errors) {
    report.errors.push({ item, detail, retry: cleanupRetry(branch) })
  }
  if (measurement.stoppedAtLimit) {
    report.errors.push({
      item,
      detail: 'storage walk stopped at its entry cap',
      retry: cleanupRetry(branch),
    })
  }
}

function reportKeptRuns(
  decisions: readonly ShipCleanupRunDecision[],
  report: ShipCleanupReport,
): void {
  for (const decision of decisions) {
    if (decision.scope === 'outside' || decision.artifacts !== 'keep') continue
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

function closeBranchWorktrees(
  branch: string,
  decisions: readonly ShipCleanupRunDecision[],
  report: ShipCleanupReport,
  adapter: ShipCleanupDependencies,
): void {
  const closeRows = decisions.filter(
    (decision) => decision.worktreeAction === 'close' && decision.worktree,
  )
  const closedRoots = new Set<number>()
  for (const row of closeRows) {
    if (closedRoots.has(row.rootId)) continue
    closedRoots.add(row.rootId)
    try {
      const result = adapter.closeOut(row.id)
      if (result.outcome === 'released' || result.outcome === 'absent') {
        if (row.worktree) report.removed.worktrees.push(row.worktree)
        continue
      }
      report.kept.push({ item: `run ${row.id} worktree`, reason: result.detail })
      report.errors.push({
        item: `run ${row.id} worktree`,
        detail: `close-out ${result.outcome}: ${result.detail}`,
        retry: cleanupRetry(branch),
      })
    } catch (cause) {
      report.errors.push({
        item: `run ${row.id} worktree`,
        detail: cause instanceof Error ? cause.message : String(cause),
        retry: cleanupRetry(branch),
      })
    }
  }
}

function removeRunStorage(
  branch: string,
  decisions: readonly ShipCleanupRunDecision[],
  beforeWorktrees: ReturnType<ShipCleanupDependencies['measure']>,
  worktreePaths: readonly string[],
  report: ShipCleanupReport,
  adapter: ShipCleanupDependencies,
): void {
  const removable = decisions.filter((decision) => decision.artifacts === 'remove')
  const artifactPaths = removable.map((run) => runArtifactsDir(run.id))
  const scratchPaths = removable.map((run) => runScratchDir(run.id))
  let archivePaths: string[] = []
  try {
    archivePaths = [
      ...new Set(removable.flatMap((run) => adapter.readerCloneArchive(run.id) ?? [])),
    ]
  } catch (cause) {
    report.errors.push({
      item: 'reader clone archives',
      detail: cause instanceof Error ? cause.message : String(cause),
      retry: cleanupRetry(branch),
    })
  }

  const beforeArtifacts = adapter.measure(artifactPaths)
  const beforeScratch = adapter.measure(scratchPaths)
  for (const path of [...archivePaths, ...artifactPaths, ...scratchPaths]) {
    try {
      adapter.remove(path)
    } catch (cause) {
      report.errors.push({
        item: path,
        detail: cause instanceof Error ? cause.message : String(cause),
        retry: cleanupRetry(branch),
      })
    }
  }
  const afterArtifacts = adapter.measure(artifactPaths)
  const afterScratch = adapter.measure(scratchPaths)
  const afterWorktrees = adapter.measure([...worktreePaths, ...archivePaths])
  report.freed.artifacts = Math.max(0, beforeArtifacts.bytes - afterArtifacts.bytes)
  report.freed.scratch = Math.max(0, beforeScratch.bytes - afterScratch.bytes)
  report.freed.worktrees = Math.max(0, beforeWorktrees.bytes - afterWorktrees.bytes)
  report.removed.artifacts.push(...removable.map((run) => run.id))
  report.removed.scratch.push(...removable.map((run) => run.id))
  reportMeasurementErrors(branch, 'artifacts', beforeArtifacts, report)
  reportMeasurementErrors(branch, 'artifacts', afterArtifacts, report)
  reportMeasurementErrors(branch, 'scratch', beforeScratch, report)
  reportMeasurementErrors(branch, 'scratch', afterScratch, report)
  reportMeasurementErrors(branch, 'worktrees', beforeWorktrees, report)
  reportMeasurementErrors(branch, 'worktrees', afterWorktrees, report)
}

function pruneMergedBranch(
  branch: string,
  report: ShipCleanupReport,
  adapter: ShipCleanupDependencies,
): void {
  try {
    const pruned = adapter.prune(report.project, branch)
    report.removed.branches.push(...pruned.deleted)
    report.kept.push(
      ...pruned.kept.map((item) => ({ item: `branch ${item.branch}`, reason: item.reason })),
    )
    report.errors.push(
      ...pruned.errors.map((detail) => ({
        item: `branch ${branch}`,
        detail,
        retry: cleanupRetry(branch),
      })),
    )
  } catch (cause) {
    report.errors.push({
      item: `branch ${branch}`,
      detail: cause instanceof Error ? cause.message : String(cause),
      retry: cleanupRetry(branch),
    })
  }
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
  const landingMergedAt = recordedLanding(project.name, branch, database)
  if (
    !options.confirmedLanded &&
    !landingMergedAt &&
    adapter.landingState(project.name, branch) !== 'landed'
  ) {
    throw new Error(
      `refusing ship cleanup: branch ${branch} has not been confirmed landed; cleared by: ${PLATFORM_SLUG} pr merge ${branch}`,
    )
  }
  if (!landingMergedAt) {
    throw new Error(
      `refusing ship cleanup: branch ${branch} has no recorded landing time; cleared by: ${PLATFORM_SLUG} tree branch landed ${branch} --pr <number>`,
    )
  }
  const decisions = decideShipCleanup(branch, landingMergedAt, runFacts(project.recordId, database))
  const report = emptyReport(project.name, branch)
  reportKeptRuns(decisions, report)
  const worktreePaths = [
    ...new Set(
      decisions.flatMap((decision) =>
        decision.worktreeAction === 'close' && decision.worktree ? [decision.worktree] : [],
      ),
    ),
  ]
  const beforeWorktrees = adapter.measure(worktreePaths)
  closeBranchWorktrees(branch, decisions, report, adapter)
  removeRunStorage(branch, decisions, beforeWorktrees, worktreePaths, report, adapter)
  pruneMergedBranch(branch, report, adapter)
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
