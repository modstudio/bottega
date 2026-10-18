// concern: database maintenance
/** Sequences owner-defined migration plans for machine run protocols. */

import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { FilesystemIdentityPlan, FilesystemIdentityRun } from '../filesystem-identity-plan.ts'
import { applyRefGuardMigration, discoverRefGuardMigration } from '../resources/ref-guard.ts'
import {
  applyRetainedRefMigration,
  discoverRetainedRefMigration,
} from '../resources/resource-inventory.ts'
import { applyRunArtifactMigration, discoverRunArtifactMigration } from '../run/run-artifacts.ts'
import {
  applyCoordinatorLogMigration,
  discoverCoordinatorLogMigration,
} from '../run/run-coordinator-log.ts'
import { applyRunLeaseMigration, discoverRunLeaseMigration } from '../run/run-lease.ts'
import {
  applyWorktreeMarkerMigration,
  discoverWorktreeMarkerMigration,
} from '../worktree/worktree-attribution.ts'
import { resolveRunsDirectory } from './database-location.ts'

export type RunFilesystemMigrationReport = {
  foldersRenamed: number
  markersWritten: number
  leaseFilesRenamed: number
  retainedRefsRenamed: number
  refGuardsRenamed: number
  coordinatorLogsMoved: number
  leftAndReported: string[]
}

type RunIdentityRow = {
  id: number
  record_id: string
  worktree: string | null
  project_path: string | null
}

export type RunFilesystemIdentityPlans = {
  artifacts: FilesystemIdentityPlan
  markers: FilesystemIdentityPlan<string>
  leases: FilesystemIdentityPlan
  retainedRefs: ReturnType<typeof discoverRetainedRefMigration>
  refGuards: FilesystemIdentityPlan
  coordinatorLogs: FilesystemIdentityPlan
}

const RUNS_QUERY = `SELECT run.id,run.record_id,run.worktree,project.path project_path
  FROM run LEFT JOIN project ON project.record_id=run.project_record_id ORDER BY run.id`

export function liveRunFilesystemMigrationRefusal(database: Database): string | null {
  const live = database
    .query<{ id: number }, []>(
      "SELECT id FROM run WHERE status IN ('reserved','attached','running','asking') ORDER BY id LIMIT 1",
    )
    .get()
  return live
    ? `run ${live.id} is live; wait for it to finish or stop it, then rerun ${PLATFORM_SLUG} machine migrate`
    : null
}

function worktreesReadByMigration(database: Database, runs: RunIdentityRow[]): Set<string> {
  const worktrees = new Set(runs.flatMap((run) => (run.worktree ? [run.worktree] : [])))
  const projects = database
    .query<{ path: string }, []>('SELECT path FROM project WHERE retired_at IS NULL')
    .all()
  for (const project of projects) {
    const root = join(project.path, '.claude', 'worktrees')
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) worktrees.add(join(root, entry.name))
    }
  }
  return worktrees
}

/** Discover every owner plan once. The plans are then the sole pending/apply authority. */
export function discoverRunFilesystemIdentityMigration(
  database: Database,
  runsDirectory = resolveRunsDirectory(process.env),
): RunFilesystemIdentityPlans {
  const rows = database.query<RunIdentityRow, []>(RUNS_QUERY).all()
  const runs = new Map<string, FilesystemIdentityRun>(
    rows.map((run) => [
      String(run.id),
      { number: String(run.id), recordId: run.record_id, projectPath: run.project_path },
    ]),
  )
  const projectPaths = database
    .query<{ name: string; path: string }, []>('SELECT name,path FROM project')
    .all()
  return {
    artifacts: discoverRunArtifactMigration(runsDirectory, runs),
    markers: discoverWorktreeMarkerMigration(worktreesReadByMigration(database, rows), runs),
    leases: discoverRunLeaseMigration(runsDirectory, runs),
    retainedRefs: discoverRetainedRefMigration(projectPaths, runs),
    refGuards: discoverRefGuardMigration(projectPaths, runs),
    coordinatorLogs: discoverCoordinatorLogMigration(runsDirectory, runs),
  }
}

const allPlans = (plans: RunFilesystemIdentityPlans): FilesystemIdentityPlan<unknown>[] =>
  Object.values(plans) as FilesystemIdentityPlan<unknown>[]

function collisionRecovery(plans: RunFilesystemIdentityPlans): string | null {
  const collision = allPlans(plans).flatMap((plan) => plan.collisions)[0]
  if (!collision) return null
  return `${collision.source}: UUID destination already exists at ${collision.destination}; move or remove one copy after confirming its owner, then rerun ${PLATFORM_SLUG} machine migrate`
}

const unmappedMessage = (item: { source: string; number: string; reason?: string }): string =>
  `${item.source}: ${item.reason ?? `no run ${item.number}`}`

export function applyRunFilesystemIdentityMigration(
  plans: RunFilesystemIdentityPlans,
): RunFilesystemMigrationReport {
  const collision = collisionRecovery(plans)
  if (collision) throw new Error(collision)
  return {
    foldersRenamed: applyRunArtifactMigration(plans.artifacts),
    markersWritten: applyWorktreeMarkerMigration(plans.markers),
    leaseFilesRenamed: applyRunLeaseMigration(plans.leases),
    retainedRefsRenamed: applyRetainedRefMigration(plans.retainedRefs),
    refGuardsRenamed: applyRefGuardMigration(plans.refGuards),
    coordinatorLogsMoved: applyCoordinatorLogMigration(plans.coordinatorLogs),
    leftAndReported: allPlans(plans).flatMap((plan) => plan.unmapped.map(unmappedMessage)),
  }
}
