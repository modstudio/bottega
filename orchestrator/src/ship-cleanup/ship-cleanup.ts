// concern: ship cleanup
/** Gathers branch cleanup facts and composes artifact removal, close-out, and branch prune. */

import type { Database } from 'bun:sqlite'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { readBranchLandingRecords } from '../branch/branch-landing-records.ts'
import {
  type BranchLandingRecord,
  type BranchPruneKeptReason,
  type BranchStateDecision,
  findRecordedBranchLanding,
} from '../branch/branch-state.ts'
import {
  classifyMintedBranch,
  type GitRefObservation,
  observeGitRef,
  pruneBranch,
} from '../branch/branches.ts'
import { taskKeyToken } from '../branch/other-branch-state.ts'
import {
  type RemovedRunTree,
  type RemovedTreeDockerCleanup,
  reclaimRemovedTreeDockerResources,
} from '../cleanup/cleanup-sweep-docker.ts'
import { renderUnjudgedRunRemedy } from '../cleanup/unjudged-run-remedy.ts'
import { closeOutRun } from '../close/close-out.ts'
import { writableDb } from '../database/db.ts'
import { type HookTreeRemovalResult, removeHookTreeResult } from '../hook-tree/tree.ts'
import { projectAt, projectByName } from '../project/projects.ts'
import {
  type RemovedTreeProcessCleanup,
  reclaimRemovedTreeProcesses,
} from '../reclaim/orphan-process-reclaim.ts'
import { runArtifactsDir, runScratchDir } from '../run/run-artifacts.ts'
import { STORAGE_WALK_ENTRY_LIMIT, walkStoragePaths } from '../storage-walk.ts'
import { removalWorkingDirectoryRefusal } from '../worktree/removal-working-directory.ts'
import {
  decideShipCleanup,
  decideShipCleanupVerdict,
  decideTaskBranchesToPrune,
  type ShipCleanupKeptReasonKind,
  type ShipCleanupRunDecision,
  type ShipCleanupRunFact,
} from './ship-cleanup-decision.ts'

type RunRow = {
  record_id: string
  number: number
  root_number: number
  parent_run_record_id: string | null
  started_at: string
  job: string
  status: string
  branch: string | null
  minted_branch: string | null
  launch_key: string | null
  evidence_excluded: string | null
  root_failure_kind: string | null
  worktree: string | null
}

export type ShipCleanupReport = {
  project: string
  branch: string
  freed: { artifacts: number; scratch: number; worktrees: number }
  removed: { artifacts: string[]; scratch: string[]; worktrees: string[]; branches: string[] }
  reclaimed: { processes: string[]; compose: string[] }
  gone: string[]
  kept: { item: string; reason: string; reasonKind: ShipCleanupKeptReasonKind; remedy?: string }[]
  errors: { item: string; detail: string; retry: string }[]
  verdict: import('./ship-cleanup-decision.ts').ShipCleanupVerdict
}

export type ShipCleanupDependencies = {
  landingState(project: string, branch: string): BranchStateDecision
  observeBranchRef(projectPath: string, branch: string): GitRefObservation
  closeOut(runId: string): { outcome: string; detail: string }
  prune(
    project: string,
    branch: string,
  ): {
    deleted: string[]
    kept: { branch: string; reason: BranchPruneKeptReason }[]
    errors: string[]
  }
  measure(paths: readonly string[]): { bytes: number; errors: string[]; stoppedAtLimit: boolean }
  readerCloneArchive(runId: string): string | null
  removeLandingTree(path: string): HookTreeRemovalResult
  runsFromTree(path: string): boolean
  remove(path: string): void
  reclaimProcesses(paths: readonly string[]): RemovedTreeProcessCleanup
  reclaimCompose(trees: readonly RemovedRunTree[]): RemovedTreeDockerCleanup
}

const dependencies: ShipCleanupDependencies = {
  landingState: (project, branch) => classifyMintedBranch(project, branch),
  observeBranchRef: (projectPath, branch) => observeGitRef(projectPath, `refs/heads/${branch}`),
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
  removeLandingTree: removeHookTreeResult,
  runsFromTree: (path) => removalWorkingDirectoryRefusal(path, '') !== null,
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  reclaimProcesses: reclaimRemovedTreeProcesses,
  reclaimCompose: reclaimRemovedTreeDockerResources,
}

function runFacts(projectRecordId: string, database: Database): ShipCleanupRunFact[] {
  const rows = database
    .query(
      `SELECT r.record_id,r.number,r.parent_run_record_id,r.started_at,r.job,r.status,r.branch,
              r.minted_branch,r.launch_key,r.evidence_excluded,r.worktree,
              root.number AS root_number,root.failure_kind AS root_failure_kind
         FROM run r
         JOIN run root ON root.record_id=COALESCE(r.parent_run_record_id,r.record_id)
        WHERE r.project_record_id=? ORDER BY r.number`,
    )
    .all(projectRecordId) as RunRow[]
  const scored = new Set(
    (
      database
        .query(
          `SELECT score.run_record_id FROM score JOIN run ON run.record_id=score.run_record_id
            WHERE run.project_record_id=?`,
        )
        .all(projectRecordId) as { run_record_id: string }[]
    ).map((row) => row.run_record_id),
  )
  const excludedRoots = new Set(
    rows
      .filter((row) => row.evidence_excluded !== null)
      .map((row) => row.parent_run_record_id ?? row.record_id),
  )
  return rows.map((row) => {
    const rootId = row.parent_run_record_id ?? row.record_id
    return {
      record_id: row.record_id,
      number: row.number,
      root_record_id: rootId,
      rootNumber: row.root_number,
      startedAt: row.started_at,
      job: row.job,
      status: row.status,
      branch: row.branch,
      mintedBranch: row.minted_branch,
      launchKey: row.launch_key,
      judged: scored.has(rootId) || excludedRoots.has(rootId),
      rootFailureKind: row.root_failure_kind,
      worktree: row.worktree,
    }
  })
}

function recordedLanding(
  project: string,
  branch: string,
  records: readonly BranchLandingRecord[],
): string | null {
  return findRecordedBranchLanding(records, project, branch)?.mergedAt ?? null
}

function emptyReport(project: string, branch: string): ShipCleanupReport {
  return {
    project,
    branch,
    freed: { artifacts: 0, scratch: 0, worktrees: 0 },
    removed: { artifacts: [], scratch: [], worktrees: [], branches: [] },
    reclaimed: { processes: [], compose: [] },
    gone: [],
    kept: [],
    errors: [],
    verdict: { clean: true },
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
        `run ${decision.number} artifacts and scratch` +
        (decision.worktreeAction === 'keep' && decision.worktree ? ' and worktree' : ''),
      reason: decision.reason,
      reasonKind: decision.worktreeAction === 'keep' ? 'live-run' : 'unjudged-run',
      ...(decision.remedy
        ? {
            remedy: renderUnjudgedRunRemedy(decision.remedy, decision.rootNumber),
          }
        : {}),
    })
  }
}

function closeBranchWorktrees(
  branch: string,
  decisions: readonly ShipCleanupRunDecision[],
  report: ShipCleanupReport,
  adapter: ShipCleanupDependencies,
  removedNow: Map<string, ReadonlySet<string>>,
  runIdsByTree: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, string> {
  const closeRows = decisions.filter(
    (decision) => decision.worktreeAction === 'close' && decision.worktree,
  )
  const closedRoots = new Set<string>()
  const keptLandingTrees = new Map<string, string>()
  for (const row of closeRows) {
    if (closedRoots.has(row.root_record_id)) continue
    closedRoots.add(row.root_record_id)
    const remedy = closeBranchWorktree(branch, row, report, adapter, removedNow, runIdsByTree)
    if (remedy && row.worktree) keptLandingTrees.set(row.worktree, remedy)
  }
  return keptLandingTrees
}

function closeBranchWorktree(
  branch: string,
  row: ShipCleanupRunDecision,
  report: ShipCleanupReport,
  adapter: ShipCleanupDependencies,
  removedNow: Map<string, ReadonlySet<string>>,
  runIdsByTree: ReadonlyMap<string, ReadonlySet<string>>,
): string | null {
  try {
    if (row.scope === 'landing-tree' && row.worktree) {
      return releaseLandingTree(
        branch,
        { ...row, worktree: row.worktree },
        report,
        adapter,
        removedNow,
        runIdsByTree,
      )
    }
    const result = adapter.closeOut(row.record_id)
    if (result.outcome === 'released' || result.outcome === 'absent') {
      if (row.worktree) report.removed.worktrees.push(row.worktree)
      if (result.outcome === 'released' && row.worktree)
        removedNow.set(row.worktree, runIdsByTree.get(row.worktree) ?? new Set([row.record_id]))
      return null
    }
    report.kept.push({
      item: `run ${row.number} worktree`,
      reason: result.detail,
      reasonKind: 'cleanup-failure',
    })
    report.errors.push({
      item: `run ${row.number} worktree`,
      detail: `close-out ${result.outcome}: ${result.detail}`,
      retry: cleanupRetry(branch),
    })
  } catch (cause) {
    report.errors.push({
      item: `run ${row.number} worktree`,
      detail: cause instanceof Error ? cause.message : String(cause),
      retry: cleanupRetry(branch),
    })
  }
  return null
}

function releaseLandingTree(
  branch: string,
  row: ShipCleanupRunDecision & { worktree: string },
  report: ShipCleanupReport,
  adapter: ShipCleanupDependencies,
  removedNow: Map<string, ReadonlySet<string>>,
  runIdsByTree: ReadonlyMap<string, ReadonlySet<string>>,
): string | null {
  const remedy = `${PLATFORM_SLUG} tree remove ${row.worktree}, then ${cleanupRetry(branch)}`
  if (adapter.runsFromTree(row.worktree)) {
    report.kept.push({
      item: `run ${row.number} worktree`,
      reason: 'the command runs from this tree',
      reasonKind: 'command-tree',
      remedy,
    })
    return remedy
  }
  const result = adapter.removeLandingTree(row.worktree)
  if (result.outcome === 'released') {
    report.removed.worktrees.push(row.worktree)
    removedNow.set(row.worktree, runIdsByTree.get(row.worktree) ?? new Set([row.record_id]))
    return null
  }
  if (result.outcome === 'kept') {
    report.kept.push({
      item: `run ${row.number} worktree`,
      reason: result.reason,
      reasonKind: 'safety-hold',
      remedy,
    })
    return remedy
  }
  report.errors.push({
    item: `run ${row.number} worktree`,
    detail: result.detail,
    retry: cleanupRetry(branch),
  })
  return null
}

function reclaimRemovedTreeLeftovers(
  branch: string,
  trees: readonly RemovedRunTree[],
  report: ShipCleanupReport,
  adapter: ShipCleanupDependencies,
): void {
  try {
    const processResult = adapter.reclaimProcesses(trees.map(({ path }) => path))
    report.reclaimed.processes.push(...processResult.reclaimed)
    report.kept.push(
      ...processResult.kept.map((item) => ({ ...item, reasonKind: 'safety-hold' as const })),
    )
    report.errors.push(
      ...processResult.errors.map((detail) => ({
        item: 'removed-tree processes',
        detail,
        retry: cleanupRetry(branch),
      })),
    )
  } catch (cause) {
    report.errors.push({
      item: 'removed-tree processes',
      detail: cause instanceof Error ? cause.message : String(cause),
      retry: cleanupRetry(branch),
    })
  }
  try {
    const composeResult = adapter.reclaimCompose(trees)
    report.reclaimed.compose.push(...composeResult.removed)
    report.kept.push(
      ...composeResult.kept.map((item) => ({ ...item, reasonKind: 'safety-hold' as const })),
    )
    report.errors.push(
      ...composeResult.errors.map((detail) => ({
        item: 'removed-tree Compose resources',
        detail,
        retry: cleanupRetry(branch),
      })),
    )
  } catch (cause) {
    report.errors.push({
      item: 'removed-tree Compose resources',
      detail: cause instanceof Error ? cause.message : String(cause),
      retry: cleanupRetry(branch),
    })
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
  const artifactPaths = removable.map((run) => runArtifactsDir(run.record_id))
  const scratchPaths = removable.map((run) => runScratchDir(run.record_id))
  let archivePaths: string[] = []
  try {
    archivePaths = [
      ...new Set(removable.flatMap((run) => adapter.readerCloneArchive(run.record_id) ?? [])),
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
  report.removed.artifacts.push(...removable.map((run) => run.record_id))
  report.removed.scratch.push(...removable.map((run) => run.record_id))
  reportMeasurementErrors(branch, 'artifacts', beforeArtifacts, report)
  reportMeasurementErrors(branch, 'artifacts', afterArtifacts, report)
  reportMeasurementErrors(branch, 'scratch', beforeScratch, report)
  reportMeasurementErrors(branch, 'scratch', afterScratch, report)
  reportMeasurementErrors(branch, 'worktrees', beforeWorktrees, report)
  reportMeasurementErrors(branch, 'worktrees', afterWorktrees, report)
}

function pruneMergedBranches(
  branches: readonly string[],
  report: ShipCleanupReport,
  adapter: ShipCleanupDependencies,
  keptLandingTrees: ReadonlyMap<string, string>,
): void {
  for (const branch of branches) {
    try {
      const pruned = adapter.prune(report.project, branch)
      report.removed.branches.push(...pruned.deleted)
      const landingTreeRemedy = keptLandingTrees.values().next().value
      report.kept.push(
        ...pruned.kept.map((item) => ({
          item: `branch ${item.branch}`,
          reason: item.reason,
          reasonKind: 'safety-hold' as const,
          ...(item.reason === 'checked-out' && landingTreeRemedy
            ? { remedy: landingTreeRemedy }
            : {}),
        })),
      )
      report.errors.push(
        ...pruned.errors.map((detail) => ({
          item: `branch ${branch}`,
          detail,
          retry: cleanupRetry(report.branch),
        })),
      )
    } catch (cause) {
      report.errors.push({
        item: `branch ${branch}`,
        detail: cause instanceof Error ? cause.message : String(cause),
        retry: cleanupRetry(report.branch),
      })
    }
  }
}

function taskCleanupPlan(input: {
  project: string
  projectPath: string
  keyPrefixes: readonly string[]
  branch: string
  facts: readonly ShipCleanupRunFact[]
  landingRecords: readonly BranchLandingRecord[]
  adapter: ShipCleanupDependencies
}) {
  const taskKey =
    taskKeyToken(input.branch, input.keyPrefixes) ??
    input.facts.find((run) => run.branch === input.branch || run.mintedBranch === input.branch)
      ?.launchKey ??
    null
  const candidateBranches = new Set(
    input.facts.flatMap((run) =>
      run.launchKey === taskKey && run.mintedBranch ? [run.mintedBranch] : [],
    ),
  )
  const localBranches = new Set<string>()
  if (taskKey) {
    for (const branch of candidateBranches) {
      const observation = input.adapter.observeBranchRef(input.projectPath, branch)
      if (observation.outcome === 'failed') throw new Error(observation.detail)
      if (observation.outcome === 'present') localBranches.add(branch)
    }
  }
  const branches = taskKey
    ? decideTaskBranchesToPrune(
        taskKey,
        input.facts,
        localBranches,
        new Map(
          [...candidateBranches].map((branch) => {
            const recorded = findRecordedBranchLanding(input.landingRecords, input.project, branch)
            return [
              branch,
              recorded
                ? {
                    state: 'landed' as const,
                    landedBy: { type: 'recorded' as const, ...recorded },
                  }
                : input.adapter.landingState(input.project, branch),
            ] as const
          }),
        ),
      )
    : { delete: [], landingProof: [], keep: [], gone: [] }
  const deleteBranches = candidateBranches.has(input.branch)
    ? branches.delete
    : [...new Set([input.branch, ...branches.delete])]
  return {
    taskKey,
    branches: { ...branches, delete: deleteBranches },
    landedBranches: new Set([input.branch, ...branches.landingProof]),
  }
}

type ShipCleanupOptions = {
  cwd?: string
  project?: string
  confirmedLanded?: boolean
  database?: Database
  dependencies?: ShipCleanupDependencies
}

function runIdsByTree(decisions: readonly ShipCleanupRunDecision[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const decision of decisions) {
    if (!decision.worktree) continue
    const ids = result.get(decision.worktree) ?? new Set<string>()
    ids.add(decision.record_id)
    result.set(decision.worktree, ids)
  }
  return result
}

export function shipCleanup(branch: string, options: ShipCleanupOptions = {}): ShipCleanupReport {
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
  const landingRecords = readBranchLandingRecords(database)
  const landingMergedAt = recordedLanding(project.name, branch, landingRecords)
  if (
    !options.confirmedLanded &&
    !landingMergedAt &&
    adapter.landingState(project.name, branch).state !== 'landed'
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
  const facts = runFacts(project.recordId, database)
  const {
    taskKey,
    branches: taskBranches,
    landedBranches,
  } = taskCleanupPlan({
    project: project.name,
    projectPath: project.path,
    keyPrefixes: project.settings.keyPrefixes ?? [],
    branch,
    facts,
    landingRecords,
    adapter,
  })
  const decisions = decideShipCleanup(taskKey ?? '', landedBranches, landingMergedAt, facts)
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
  const treeRunIds = runIdsByTree(decisions)
  const removedNow = new Map<string, ReadonlySet<string>>()
  const keptLandingTrees = closeBranchWorktrees(
    branch,
    decisions,
    report,
    adapter,
    removedNow,
    treeRunIds,
  )
  reclaimRemovedTreeLeftovers(
    branch,
    [...removedNow].map(([path, removedRunIds]) => ({ path, removedRunIds })),
    report,
    adapter,
  )
  removeRunStorage(branch, decisions, beforeWorktrees, worktreePaths, report, adapter)
  report.kept.push(
    ...taskBranches.keep.map((item) => ({
      item: `branch ${item.branch}`,
      reason: item.reason,
      reasonKind: 'landing-not-proved' as const,
    })),
  )
  report.gone.push(...taskBranches.gone)
  pruneMergedBranches(taskBranches.delete, report, adapter, keptLandingTrees)
  report.verdict = decideShipCleanupVerdict(report, true)
  return report
}

export function formatShipCleanup(report: ShipCleanupReport): string {
  const lines = [
    `ship cleanup ${report.project}/${report.branch}`,
    `freed: artifacts ${report.freed.artifacts} bytes; scratch ${report.freed.scratch} bytes; worktrees ${report.freed.worktrees} bytes`,
    `reclaimed: processes ${report.reclaimed.processes.length}; Compose resources ${report.reclaimed.compose.length}`,
  ]
  for (const item of report.reclaimed.processes) lines.push(`reclaimed process: ${item}`)
  for (const item of report.reclaimed.compose) lines.push(`reclaimed Compose resource: ${item}`)
  for (const branch of report.gone) lines.push(`already gone: ${branch}`)
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
