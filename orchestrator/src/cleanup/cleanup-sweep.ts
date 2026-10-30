/** Cleanup sweep knows worktree ownership, leases and the cleanup lock, resource reclamation, and branch retention. It must not know transports, routing, reviews, contracts, the CLI, or durable execution. */

import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { pidAlive } from '../../../shared/process-identity.ts'
import { stampEndedClaims } from '../board/board-claim-service.ts'
import { reapBoardReach } from '../board/board-reach.ts'
import { reapBoardMessages } from '../board/board-service.ts'
import { pruneExpiredBranchDisposalArchives } from '../branch/branch-disposal.ts'
import { closeOutRun } from '../close/close-out.ts'
import { namedProjectTreePaths } from '../close/tree-keep.ts'
import { treeProcessCwdHold } from '../close/tree-process-cwd-hold.ts'
import { db, SESSION_LIVE_MS, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { expireUnjudgedRun, unjudgedRuns } from '../evidence/unjudged-expiry.ts'
import { shouldSweepHookTree } from '../hook-tree/hook-tree.ts'
import { filedIssueLoopRun } from '../issue/issue-queue.ts'
import { observeLandingTreeRelease } from '../landing-tree/release-observation.ts'
import {
  isProjectRepository,
  type Project,
  projectAt,
  projectByName,
  projects,
} from '../project/projects.ts'
import {
  automaticOrphanReclaimDecision,
  liveRunWorktrees,
  orphansWithOwnershipEvidence,
  reclaimOrphanProcess,
} from '../reclaim/orphan-process-reclaim.ts'
import type { DockerResource } from '../resources/docker-resources.ts'
import { sweepIdleMainStacks } from '../resources/main-stack.ts'
import { currentOrphanProcesses } from '../resources/process-inventory.ts'
import {
  liveWorktreeSharers,
  recordedWorktreeSharerRunIds,
} from '../resources/resource-ownership.ts'
import { recordedRunLivenessFacts, runAlive } from '../run/run-alive.ts'
import { auditRunMutation } from '../run/run-authority.ts'
import {
  removeFreeRunCloseOutLease,
  removeFreeRunLease,
  runCloseOutLeaseIds,
  runLeaseIds,
  runLeaseState,
} from '../run/run-lease.ts'
import { recordedOwnerProcess } from '../run/run-owner-session-liveness.ts'
import { TERMINAL_RUN_STATUS_SET, TERMINAL_RUN_STATUS_SQL } from '../run/run-status.ts'
import { sweepRunTaskLinks } from '../run/run-task-linking.ts'
import { LANDING_TREE_JOB } from '../run/synthetic-lifecycle-job.ts'
import type { GrokTrustObservation } from '../sandbox/grok-trust.ts'
import type { HubTaskReader } from '../workflow/workflow-task-reference.ts'
import {
  inspectTreeOwnership,
  isOrchWorktree,
  markedWorktreeSource,
  orphanSafety,
  worktreeNameRunId,
} from '../worktree/worktree-attribution.ts'
import { branchTip } from '../worktree/worktree-remove.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { landingInFlight, reconcileAbsentClaims } from './claim-reconciliation.ts'
import {
  type CleanupPresentation,
  evidenceOwningBranchOwners,
  resourcesForConversation,
  verifyBranchOwnershipAfterCleanup,
  withCleanupLock,
} from './cleanup.ts'
import {
  decideConversationProjectOwnership,
  decideFilesystemOrphanAfterRemoval,
  decideFilesystemOrphanEligibility,
  decideFilesystemOrphanUnderLock,
  decideRecordedRunCloseOut,
  decideRecordedRunPointer,
  decideRecordedRunPostInventory,
  decideRecordedRunPreInventory,
  isSweepCandidate,
  type RecordedRunPostInventoryFacts,
  shouldExpireUnjudgedOwner,
  UNJUDGED_OWNER_WINDOW_MS,
} from './cleanup-sweep-decisions.ts'
import { reclaimSweptDockerResources } from './cleanup-sweep-docker.ts'
import { holdNamedFilesystemOrphans } from './cleanup-sweep-named-tree.ts'
import { finishRemovedOrphan, reportOrphanAfterRemovalKeep } from './cleanup-sweep-orphan-report.ts'
import { pruneSweptProjectBranches, reclaimAbsentTrustEntries } from './cleanup-sweep-reclaim.ts'
import { sweepUnattendedResidue } from './cleanup-sweep-residue.ts'
import { heldProjectTrees, sweepProject } from './project-sweep.ts'
import { pruneReaderCloneArchives } from './reader-clone-archive-retention.ts'
import { sweepRunLeftovers } from './run-leftover-sweep.ts'
import { sweepStrayWorktreeDirectories } from './stray-worktree-sweep.ts'

function reapExpiredBoardMessages(dryRun: boolean): void {
  if (!dryRun) {
    stampEndedClaims()
    reapBoardMessages()
    reapBoardReach(Date.now(), writableDb())
  }
}

async function sweepOrphanProcesses(
  sweepProjects: Project[],
  dryRun: boolean,
  presentation: CleanupPresentation,
): Promise<boolean> {
  const inventory = currentOrphanProcesses(sweepProjects)
  let failed = false
  if (inventory.error) {
    presentation.error(`orphan process inventory failed: ${inventory.error}`)
    failed = true
  }
  const liveWorktrees = liveRunWorktrees()
  const orphans = orphansWithOwnershipEvidence(inventory.orphans)
  for (const process of orphans) {
    const decision = automaticOrphanReclaimDecision(process, liveWorktrees)
    if (!decision.reclaim) {
      presentation.log(`kept process ${process.pid}: ${decision.reason}`)
      continue
    }
    const result = await reclaimOrphanProcess(String(process.pid), dryRun)
    if (result.ok) presentation.log(result.action)
    else {
      failed = true
      presentation.error(result.action)
    }
  }
  return failed
}

function rememberedWorktrees(): Set<string> {
  const rows = db().query('SELECT worktree FROM run WHERE worktree IS NOT NULL').all() as {
    worktree: string
  }[]
  return new Set(
    rows.map((row) => (existsSync(row.worktree) ? realpathSync(row.worktree) : row.worktree)),
  )
}

export type SweepOptions = {
  dryRun: boolean
  verbose?: boolean
  project?: string
  force: boolean
  presentation: CleanupPresentation
}
export type SweepHelpers = {
  observeGrokTrustHeadings: () => GrokTrustObservation
  grokTrustPathFromHeading: (heading: string) => string | null
  hubTaskReader: HubTaskReader
}

const KEPT_ROW_LIMIT = 10

type NamedRun = { record_id: string; status: string; alive: boolean }

function worktreeSharerList(rows: { record_id: string; status: string }[]): string {
  return rows.map((owner) => `${owner.record_id} (${owner.status})`).join(', ')
}

function heldKeeper(
  keep: (line: string, reason: string) => void,
  add: (projectName: string, path: string | null) => void,
  projectName: string,
  path: string,
): (line: string, reason: string) => void {
  return (line, reason) => {
    keep(line, reason)
    add(projectName, path)
  }
}

function keepTreeProcessCwdHold(
  runId: string,
  path: string,
  keepHeld: (line: string, reason: string) => void,
): boolean {
  const hold = treeProcessCwdHold({ runId, worktree: path, treeAbsent: false })
  if (!hold) return false
  keepHeld(`orphan  ${path}  ${hold.detail}`, hold.detail)
  return true
}

function holdRecordedCloseOutcome(
  outcome: 'released' | 'forgotten' | 'held' | 'live' | 'absent' | 'failed',
  projectName: string | null,
  path: string | null,
  add: (projectName: string, path: string | null) => void,
): void {
  if (projectName && ['forgotten', 'held', 'live', 'failed'].includes(outcome))
    add(projectName, path)
}

type NamedRunLookup =
  | { outcome: 'absent' }
  | { outcome: 'owned'; run: NamedRun }
  | { outcome: 'unknown'; runId: string; reason: string }
type ClosedSweepOutcome = 'released' | 'absent' | 'forgotten'
type SweepCandidate = {
  record_id: string
  root_record_id: string
  repo: string | null
  project_record_id: string | null
  worktree: string | null
  branch: string | null
  base_commit: string | null
  status: string
  worktree_source: Worktree['source'] | null
  job: string
  pid: number | null
  agent_pid: number | null
  session_id: string | null
  session_last_seen: string | null
  harness_wall_bound_ms: number | null
  launch_key: string | null
}
type ClosedSweepCounts = Record<ClosedSweepOutcome, number>

function namedRun(name: string, project: Project): NamedRunLookup {
  const runRecordId = worktreeNameRunId(name)
  if (runRecordId === null) return { outcome: 'absent' }
  const member = db()
    .query(
      `SELECT member.record_id, member.parent_run_record_id,
              member.project_record_id, root.project_record_id root_project_record_id
       FROM run member
       JOIN run root ON root.record_id=COALESCE(member.parent_run_record_id,member.record_id)
       WHERE member.record_id=?`,
    )
    .get(runRecordId) as {
    record_id: string
    parent_run_record_id: string | null
    project_record_id: string | null
    root_project_record_id: string | null
  } | null
  if (!member) return { outcome: 'absent' }

  const rootId = member.parent_run_record_id ?? member.record_id
  const members = db()
    .query(
      `SELECT record_id,project_record_id
       FROM run
       WHERE record_id=? OR parent_run_record_id=?
       ORDER BY number`,
    )
    .all(rootId, rootId) as { record_id: string; project_record_id: string | null }[]
  const ownership = decideConversationProjectOwnership({
    root: { record_id: rootId, projectRecordId: member.root_project_record_id },
    members: members.map(({ record_id, project_record_id }) => ({
      record_id,
      projectRecordId: project_record_id,
    })),
    expectedProjectRecordId: project.recordId,
  })
  if (ownership.outcome === 'unknown')
    return {
      outcome: 'unknown',
      runId: member.record_id,
      reason: ownership.reason,
    }
  const latest = db()
    .query(
      `SELECT record_id,status,pid,executor,session_id,started_at,job,harness_wall_bound_ms,
              (SELECT last_seen FROM session_seen WHERE session_id=run.session_id) session_last_seen FROM run
      WHERE record_id=? OR parent_run_record_id=?
      ORDER BY turn DESC, number DESC LIMIT 1`,
    )
    .get(rootId, rootId) as {
    record_id: string
    status: string
    pid: number | null
    executor: 'external' | 'harness'
    session_id: string | null
    started_at: string
    job: string
    session_last_seen: string | null
    harness_wall_bound_ms: number | null
  }
  return {
    outcome: 'owned',
    run: {
      record_id: member.record_id,
      status: latest.status,
      alive: runAlive({
        status: latest.status,
        lease: runLeaseState(latest.record_id),
        pidAlive: Boolean(latest.pid && pidAlive(latest.pid)),
        ...recordedRunLivenessFacts(
          latest,
          Date.now(),
          SESSION_LIVE_MS,
          recordedOwnerProcess(db(), latest.session_id),
        ),
      }),
    },
  }
}

function namedRunAlive(lookup: NamedRunLookup): boolean {
  if (lookup.outcome === 'unknown') throw new Error(lookup.reason)
  return lookup.outcome === 'owned' && lookup.run.alive
}

function observeNamedRunForSweep(
  path: string,
  project: Project,
  label: string,
  presentation: CleanupPresentation,
): { alive: boolean; failed: boolean } {
  const lookup = namedRun(path, project)
  if (lookup.outcome !== 'unknown') return { alive: namedRunAlive(lookup), failed: false }
  presentation.error(`could not reclaim ${label}: ${lookup.reason}`)
  return { alive: true, failed: true }
}

type OrphanCandidateDecision =
  | { action: 'keep'; line: string; reason: string; failed: boolean; held: boolean }
  | { action: 'dry'; detail: string; failed: boolean }
  | {
      action: 'reclaim'
      runId: string
      safe: ReturnType<typeof orphanSafety>
      failed: boolean
    }

function orphanCandidateDecision(
  path: string,
  project: Project,
  label: string,
  dry: boolean,
  presentation: CleanupPresentation,
): OrphanCandidateDecision {
  const runRecordId = worktreeNameRunId(path)
  if (runRecordId === null) {
    return {
      action: 'keep',
      line: 'kept: no UUID ownership marker',
      reason: 'ownership cannot be attributed',
      failed: false,
      held: false,
    }
  }
  const owner = db()
    .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE record_id=?')
    .get(runRecordId)
  if (!owner) {
    return {
      action: 'keep',
      line: 'kept: marker UUID has no run record',
      reason: 'ownership cannot be attributed',
      failed: false,
      held: false,
    }
  }
  const named = observeNamedRunForSweep(path, project, label, presentation)
  const trunk =
    typeof project.settings.trunk === 'string' && project.settings.trunk.trim()
      ? project.settings.trunk
      : 'HEAD'
  const safe = orphanSafety(path, project.path, trunk)
  const ruling = decideFilesystemOrphanEligibility({
    orchOwned: isOrchWorktree(path),
    alive: named.alive,
    safe,
    dry,
  })
  if (ruling.action === 'keep') {
    return {
      action: 'keep',
      line: ruling.keepLine,
      reason: ruling.keepReason,
      failed: named.failed,
      held: named.alive || (isOrchWorktree(path) && !safe.removable),
    }
  }
  if (ruling.action === 'dry-would-reclaim') {
    return { action: 'dry', detail: safe.detail, failed: named.failed }
  }
  return { action: 'reclaim', runId: owner.record_id, safe, failed: named.failed }
}

function conversationProjectOwnershipIssue(
  rootId: string,
  expectedProjectRecordId: string | null,
): string | null {
  const members = db()
    .query(
      `SELECT record_id,project_record_id
       FROM run
       WHERE record_id=? OR parent_run_record_id=?
       ORDER BY number`,
    )
    .all(rootId, rootId) as { record_id: string; project_record_id: string | null }[]
  const root = members.find(({ record_id }) => record_id === rootId) ?? {
    record_id: rootId,
    project_record_id: null,
  }
  const ruling = decideConversationProjectOwnership({
    root: { record_id: root.record_id, projectRecordId: root.project_record_id },
    members: members.map(({ record_id, project_record_id }) => ({
      record_id,
      projectRecordId: project_record_id,
    })),
    expectedProjectRecordId: expectedProjectRecordId ?? root.project_record_id ?? '',
  })
  return ruling.outcome === 'unknown' ? ruling.reason : null
}

function sweepCandidateInProject(row: SweepCandidate, selectedProject: Project | null): boolean {
  if (!selectedProject) return true
  const members = db()
    .query('SELECT project_record_id FROM run WHERE record_id=? OR parent_run_record_id=?')
    .all(row.root_record_id, row.root_record_id) as { project_record_id: string | null }[]
  return members.some(
    ({ project_record_id }) =>
      project_record_id === selectedProject.recordId || project_record_id === null,
  )
}

function printSweepKept(
  released: number,
  absent: number,
  forgotten: number,
  kept: { line: string; reason: string }[],
  dry: boolean,
  force: boolean,
  presentation: CleanupPresentation,
): void {
  presentation.log(
    `\n${dry ? 'would reclaim' : 'reclaimed'} ${released}, already absent ${absent}, forgotten ${forgotten}, kept ${kept.length}`,
  )
  const listAll = dry
  const fits = kept.length <= KEPT_ROW_LIMIT
  const showSummary = listAll || !fits
  const showRows = listAll || fits
  if (showSummary && kept.length > 0) {
    const counts = new Map<string, number>()
    for (const row of kept) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1)
    const grouped = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const width = String(grouped[0]![1]).length
    for (const [reason, n] of grouped) {
      presentation.log(`  ${String(n).padStart(width)}  ${reason}`)
    }
  }
  if (showRows) {
    for (const row of kept) presentation.log(`  ${row.line}`)
  } else {
    const parts = [`${PLATFORM_SLUG} machine sweep --dry-run`]
    if (force) parts.push('--force')
    presentation.log(`  ${parts.join(' ')} lists every kept row`)
  }
}

/** Links run tasks after the sweep's own steps, and fails the sweep when either part failed. */
async function finishSweep(
  dry: boolean,
  cleanupFailed: boolean,
  hubTaskReader: HubTaskReader,
  presentation: CleanupPresentation,
): Promise<void> {
  const runLinks = await sweepRunTaskLinks(dry, hubTaskReader)
  presentation[runLinks.kind](runLinks.line)
  if (cleanupFailed || runLinks.kind === 'error') presentation.setExitCode(1)
}

function reportClosedSweepRow(
  outcome: ClosedSweepOutcome,
  row: { record_id: string; root_record_id: string; worktree: string | null },
  dry: boolean,
  presentation: CleanupPresentation,
): ClosedSweepOutcome {
  if (outcome === 'released' && !dry) {
    writeTransaction(() => {
      auditRunMutation(
        {
          runId: row.record_id,
          rootId: row.root_record_id,
          owner: null,
          actor: sessionId(),
          ownerLastSeenAt: null,
          chainLastActivityAt: Date.now(),
          coordinatorRun: false,
          now: Date.now(),
          windowMs: UNJUDGED_OWNER_WINDOW_MS,
        },
        'sweep',
      )
    })
  }
  const action =
    outcome === 'absent'
      ? 'already absent'
      : outcome === 'forgotten'
        ? dry
          ? 'would forget'
          : 'forgotten'
        : dry
          ? 'would reclaim'
          : 'reclaimed'
  presentation.log(`${action} ${row.record_id}  ${row.worktree}`)
  return outcome
}

function sweepTreeIsOwned(row: SweepCandidate): boolean {
  if (!row.worktree) return false
  const project = row.repo ? projectByName(row.repo) : projectAt(row.worktree)
  if (!project) return false
  const conversationIds = (
    db()
      .query(
        'SELECT record_id FROM run WHERE record_id=? OR parent_run_record_id=? ORDER BY number',
      )
      .all(row.root_record_id, row.root_record_id) as { record_id: string }[]
  ).map((turn) => turn.record_id)
  return (
    inspectTreeOwnership(
      row.worktree,
      project.path,
      conversationIds,
      recordedWorktreeSharerRunIds(db(), row.worktree),
    ) === 'owned'
  )
}

function shouldInventoryBeforeSweep(row: SweepCandidate, dry: boolean): boolean {
  return !dry && sweepTreeIsOwned(row)
}

function sweepTerminalRunLeases(dry: boolean): void {
  if (dry) return
  const leases = [
    ...runLeaseIds().map((runRecordId) => ({ runRecordId, closeOut: false })),
    ...runCloseOutLeaseIds().map((runRecordId) => ({ runRecordId, closeOut: true })),
  ]
  for (const { runRecordId, closeOut } of leases) {
    const row = db()
      .query('SELECT record_id,status FROM run WHERE record_id=?')
      .get(runRecordId) as {
      record_id: string
      status: string
    } | null
    if (row && TERMINAL_RUN_STATUS_SET.has(row.status)) {
      ;(closeOut ? removeFreeRunCloseOutLease : removeFreeRunLease)(row.record_id)
    }
  }
}

function sweepUnjudgedRuns(
  dry: boolean,
  selectedProject: { name: string } | null,
  presentation: CleanupPresentation,
): Set<string> {
  const now = Date.now()
  const evidenceExcluded = new Set<string>()
  let expired = 0
  let kept = 0
  for (const row of unjudgedRuns(selectedProject?.name ?? null)) {
    const shouldExpire = shouldExpireUnjudgedOwner({
      ownerSessionId: row.session_id,
      ownerLastSeenAt: row.session_last_seen === null ? null : Date.parse(row.session_last_seen),
      runLastActivityAt: Date.parse(row.run_last_activity),
      coordinatorRun:
        filedIssueLoopRun({ id: row.record_id, job: row.job, label: row.label }) !== null,
      now,
      windowMs: UNJUDGED_OWNER_WINDOW_MS,
    })
    if (!shouldExpire) {
      kept++
      continue
    }
    if (dry || expireUnjudgedRun(row, shouldExpireUnjudgedOwner, UNJUDGED_OWNER_WINDOW_MS)) {
      expired++
      evidenceExcluded.add(row.record_id)
      presentation.log(`${dry ? 'would expire' : 'expired'} unjudged run ${row.record_id}`)
    } else {
      kept++
    }
  }
  presentation.log(`\n${dry ? 'would expire' : 'expired'} unjudged ${expired}, kept ${kept}`)
  return evidenceExcluded
}

function sweepExpiredRunStore(
  options: Pick<SweepOptions, 'dryRun' | 'verbose'>,
  selectedProject: Project | null,
  presentation: CleanupPresentation,
): ReturnType<typeof sweepRunLeftovers> {
  const evidenceClosedRootIds = sweepUnjudgedRuns(options.dryRun, selectedProject, presentation)
  return sweepRunLeftovers({
    dryRun: options.dryRun,
    verbose: options.verbose,
    projectRecordId: selectedProject?.recordId ?? null,
    presentation,
    evidenceClosedRootIds,
  })
}

type RecordedSweepState = {
  cleanupFailed: boolean
  inventoryErrors: Set<string>
  leaked: Map<string, { resource: DockerResource; project: string; runId: string }>
  kept: { line: string; reason: string }[]
  counts: ClosedSweepCounts
  addHold: (projectName: string, path: string | null) => void
}

function applyRecordedPostInventory(
  r: SweepCandidate,
  closeOutcome: RecordedRunPostInventoryFacts['closeOutcome'],
  inventory: ReturnType<typeof resourcesForConversation>,
  state: RecordedSweepState,
  presentation: CleanupPresentation,
): void {
  const project = r.repo ?? (r.worktree ? projectAt(r.worktree)?.name : null) ?? 'unknown'
  const inventoryReason = inventory.ascertainable ? null : inventory.reason
  const resources = inventory.ascertainable ? inventory.resources : []
  const inventoryFact: RecordedRunPostInventoryFacts['inventory'] = !inventory.ascertainable
    ? 'unavailable'
    : resources.length
      ? 'leaked'
      : 'empty'
  const ruling = decideRecordedRunPostInventory({
    closeOutcome,
    inventory: inventoryFact,
  })
  state.cleanupFailed ||= ruling.cleanupFailed
  if (ruling.action === 'inventory-unavailable') {
    state.inventoryErrors.add(inventoryReason!)
    state.kept.push({
      line: `${r.record_id}  inventory unavailable`,
      reason: ruling.keepReason!,
    })
    presentation.error(`could not verify reclaim ${r.record_id}: ${ruling.presentationError}`)
  } else if (ruling.action === 'leak') {
    for (const resource of resources)
      state.leaked.set(`${resource.kind}:${resource.name}`, {
        resource,
        project,
        runId: r.record_id,
      })
    state.kept.push({
      line: `${r.record_id}  leaked Docker resources`,
      reason: ruling.keepReason!,
    })
    presentation.error(
      `could not fully reclaim ${r.record_id}: project ${project}'s ${ruling.presentationError}`,
    )
  } else {
    const outcome = reportClosedSweepRow(closeOutcome, r, false, presentation)
    state.counts[outcome]++
  }
}

function landingTreeSweepDecision(r: SweepCandidate) {
  if (!r.worktree) return { action: 'keep' as const, reason: 'landing tree path is absent' }
  return observeLandingTreeRelease({
    job: r.job,
    repo: r.repo,
    worktree: r.worktree,
    branch: r.branch,
    sessionId: r.session_id,
    launchKey: r.launch_key,
    status: r.status,
    treeExists: existsSync(r.worktree),
    landingInFlight: landingInFlightForSweep(r),
    explicitTreeRemovalRequested: false,
  })
}

function landingInFlightForSweep(r: SweepCandidate): boolean {
  if (!r.worktree || !r.branch) return false
  const project = r.repo ?? projectAt(r.worktree)?.name
  return Boolean(project && landingInFlight(db(), project, r.branch))
}

function landingTreeSweepRuling(
  r: SweepCandidate,
): { approved: true } | { approved: false; reason: string } {
  const decision = landingTreeSweepDecision(r)
  return decision.action === 'release'
    ? { approved: true }
    : { approved: false, reason: decision.reason }
}

function sweepRecordedRow(
  r: SweepCandidate,
  dry: boolean,
  state: RecordedSweepState,
  presentation: CleanupPresentation,
  expectedProjectRecordId: string | null,
): void {
  const keep = (line: string, reason: string) => state.kept.push({ line, reason })
  const projectName = r.repo ?? (r.worktree ? projectAt(r.worktree)?.name : null) ?? null
  const ownershipIssue = conversationProjectOwnershipIssue(
    r.root_record_id,
    expectedProjectRecordId,
  )
  if (ownershipIssue) {
    state.cleanupFailed = true
    keep(`${r.record_id}  ownership unknown: ${ownershipIssue}`, 'project ownership unknown')
    if (projectName) state.addHold(projectName, r.worktree)
    presentation.error(`could not reclaim ${r.record_id}: ${ownershipIssue}`)
    return
  }
  const current = db().query('SELECT worktree FROM run WHERE record_id=?').get(r.record_id) as {
    worktree: string | null
  } | null
  const pointerRuling = decideRecordedRunPointer({
    pointerUnchanged: current?.worktree === r.worktree,
  })
  if (pointerRuling.action === 'skip') return
  if (r.job === LANDING_TREE_JOB) {
    const landing = landingTreeSweepRuling(r)
    if (!landing.approved) {
      keep(`${r.record_id}  held: ${r.worktree}`, landing.reason)
      if (projectName) state.addHold(projectName, r.worktree)
      return
    }
  }
  let preInventory: 'unavailable' | 'ok' | 'not-needed' = 'not-needed'
  let preInventoryReason: string | null = null
  if (shouldInventoryBeforeSweep(r, dry)) {
    const before = resourcesForConversation(r.record_id)
    preInventory = before.ascertainable ? 'ok' : 'unavailable'
    preInventoryReason = before.ascertainable ? null : before.reason
  }
  const preInventoryRuling = decideRecordedRunPreInventory({
    inventory: preInventory,
  })
  if (preInventoryRuling.action === 'keep') {
    state.inventoryErrors.add(preInventoryReason!)
    state.cleanupFailed = preInventoryRuling.cleanupFailed
    keep(`${r.record_id}  inventory unavailable`, preInventoryRuling.keepReason)
    if (projectName) state.addHold(projectName, r.worktree)
    presentation.error(
      `could not verify reclaim ${r.record_id}: ${preInventoryRuling.presentationError}`,
    )
    return
  }
  const closed = closeOutRun(r.record_id, {
    intent: 'sweep',
    dryRun: dry,
  })
  const closeRuling = decideRecordedRunCloseOut({
    dry,
    outcome: closed.outcome,
    detail: closed.detail,
  })
  holdRecordedCloseOutcome(closed.outcome, projectName, r.worktree, state.addHold)
  if (closeRuling.action === 'report') {
    const outcome = reportClosedSweepRow(closed.outcome as ClosedSweepOutcome, r, dry, presentation)
    state.counts[outcome]++
    return
  }
  if (closeRuling.action === 'keep' || closeRuling.action === 'fail') {
    state.cleanupFailed ||= closeRuling.cleanupFailed
    keep(`${r.record_id}  ${closed.outcome}: ${closed.detail}`, closeRuling.keepReason)
    if (closeRuling.action === 'fail')
      presentation.error(`could not reclaim ${r.record_id}: ${closeRuling.presentationError}`)
    return
  }

  const inventory = resourcesForConversation(r.record_id)
  applyRecordedPostInventory(r, closeRuling.closeOutcome, inventory, state, presentation)
}

function pruneArchives(options: SweepOptions): { failed: boolean } {
  const reader = pruneReaderCloneArchives({
    dryRun: options.dryRun,
    presentation: options.presentation,
  })
  const branch = pruneExpiredBranchDisposalArchives({
    dryRun: options.dryRun,
    project: options.project,
    log: options.presentation.log,
    error: options.presentation.error,
  })
  return { failed: reader.failed > 0 || branch.failed }
}

/**
 * Reclaim worktrees, and the infrastructure behind them, without being asked.
 *
 * A worktree is not a directory here. In these projects it is a database of
 * up to a few gigabytes, a container, a port and a queue worker, and the
 * directory is the cheap part — so worktrees left behind do not merely
 * clutter, they fill the machine with databases nobody can name.
 *
 * Terminal close-out is the normal release event. Sweep is the backstop for
 * a coordinator or session that died before the pairing ran. It applies the
 * same liveness guards; scoring is not a retention signal. Uncommitted work
 * is extracted before removal rather than used as a reason to keep the tree.
 */

export async function sweepRuns(options: SweepOptions, helpers: SweepHelpers): Promise<void> {
  const dry = options.dryRun
  const selectedProject = options.project === undefined ? null : projectByName(options.project)
  if (options.project !== undefined && !selectedProject)
    throw new Error(`unknown project ${options.project}`)
  const sweepProjects = (selectedProject ? [selectedProject] : projects()).filter(
    isProjectRepository,
  )
  if (!dry) writableDb()
  reapExpiredBoardMessages(dry)
  const archiveRetention = pruneArchives(options)
  const trustObservation = helpers.observeGrokTrustHeadings()
  reconcileAbsentClaims({
    dryRun: dry,
    project: options.project,
    presentation: options.presentation,
    trust: trustObservation,
  })
  const runLeftovers = sweepExpiredRunStore(options, selectedProject, options.presentation)
  const rows = (
    db()
      .query(
        `SELECT r.record_id, COALESCE(r.parent_run_record_id, r.record_id) root_record_id,
              r.repo, r.project_record_id, r.worktree, r.branch, r.base_commit, r.worktree_source, r.status, r.job,
              r.pid, r.agent_pid, r.session_id, seen.last_seen AS session_last_seen,
              r.launch_key, r.close_out_outcome
         FROM run r
         LEFT JOIN session_seen seen ON seen.session_id=r.session_id
        WHERE r.status IN ${TERMINAL_RUN_STATUS_SQL}
        ORDER BY r.number`,
      )
      .all() as Array<SweepCandidate & { close_out_outcome: string | null }>
  )
    .filter((row) =>
      isSweepCandidate({
        status: row.status,
        worktree: row.worktree,
        closeOutOutcome: row.close_out_outcome,
      }),
    )
    .filter(
      (row) => !row.worktree || shouldSweepHookTree(row as SweepCandidate & { worktree: string }),
    )
    .filter((row) => sweepCandidateInProject(row, selectedProject))

  const { removeFor } = await import('../worktree/worktree-remove.ts')

  const closedCounts: ClosedSweepCounts = {
    released: 0,
    absent: 0,
    forgotten: 0,
  }
  let cleanupFailed = archiveRetention.failed || runLeftovers.failed
  cleanupFailed ||= sweepIdleMainStacks({
    database: db(),
    projects: sweepProjects,
    dryRun: dry,
    log: (message) => options.presentation.log(message),
    error: (message) => options.presentation.error(message),
  })
  const unattended = sweepUnattendedResidue({
    dryRun: dry,
    selectedProject: selectedProject?.name ?? null,
    presentation: options.presentation,
  })
  cleanupFailed ||= unattended.failed
  const inventoryErrors = new Set<string>()
  const leaked = new Map<string, { resource: DockerResource; project: string; runId: string }>()
  const kept: { line: string; reason: string }[] = []
  const keep = (line: string, reason: string) => {
    kept.push({ line, reason })
  }
  const { byProject: heldByProject, add: addHeld } = heldProjectTrees()
  const recordedState: RecordedSweepState = {
    cleanupFailed,
    inventoryErrors,
    leaked,
    kept,
    counts: closedCounts,
    addHold: addHeld,
  }
  sweepTerminalRunLeases(dry)
  for (const r of rows)
    sweepRecordedRow(r, dry, recordedState, options.presentation, selectedProject?.recordId ?? null)
  cleanupFailed ||= recordedState.cleanupFailed

  const strayCleanupFailed = sweepStrayWorktreeDirectories({
    projects: sweepProjects,
    database: db(),
    dryRun: dry,
    presentation: options.presentation,
  })
  cleanupFailed ||= strayCleanupFailed

  /**
   * DATABASE ROWS ARE NOT AN INVENTORY OF WHAT IS ON DISK.
   *
   * A worktree whose row never acquired its path is invisible to the loop
   * above and would otherwise leak forever. Orphans are discovered from each
   * registered project's conventional worktree root. A path git does not
   * list as a worktree is kept; uncommitted work is extracted before removal.
   * A project's own removal refusal remains final through removeWithTool().
   */
  const remembered = rememberedWorktrees()
  for (const p of sweepProjects) {
    const root = join(p.path, '.claude', 'worktrees')
    if (!existsSync(root)) continue
    const namedTrees = namedProjectTreePaths(p.name)
    holdNamedFilesystemOrphans(namedTrees, root, p.name, remembered, keep, addHeld)
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(root, entry.name)
      if (remembered.has(realpathSync(path))) continue

      const label = `orphan  ${path}`
      const keepHeld = heldKeeper(keep, addHeld, p.name, path)
      const decision = orphanCandidateDecision(path, p, label, dry, options.presentation)
      cleanupFailed ||= decision.failed
      if (decision.action === 'keep') {
        keep(`${label}  ${decision.line}`, decision.reason)
        if (decision.held) addHeld(p.name, path)
        continue
      }
      if (decision.action === 'dry') {
        options.presentation.log(`would reclaim ${label}; ${decision.detail}`)
        closedCounts.released++
        continue
      }
      const { runId, safe } = decision

      const w = {
        path,
        branch: safe.branch,
        base: '',
        repoRoot: p.path,
        source: markedWorktreeSource(path),
        mintedBranch: safe.branch,
      }
      try {
        withCleanupLock(p.path, `sweep ${label}`, path, () => {
          const ownerRow = { record_id: runId, repo: p.name, branch: safe.branch }
          const worktreeRow = { record_id: runId, worktree: path }
          const sharersBefore = liveWorktreeSharers(db(), worktreeRow)
          const locked = observeNamedRunForSweep(path, p, label, options.presentation)
          cleanupFailed ||= locked.failed
          const lockedRuling = decideFilesystemOrphanUnderLock({
            sharers: sharersBefore.length,
            lockedAlive: locked.alive,
          })
          if (lockedRuling.action === 'shared-before') {
            const owners = worktreeSharerList(sharersBefore)
            cleanupFailed ||= lockedRuling.cleanupFailed
            keepHeld(`${label}  ${lockedRuling.keepLine}: ${owners}`, lockedRuling.keepReason!)
            options.presentation.error(`could not reclaim ${label}: acquired by run(s) ${owners}`)
            return
          }
          if (lockedRuling.action === 'live') {
            keepHeld(`${label}  ${lockedRuling.keepLine}`, lockedRuling.keepReason!)
            return
          }
          if (keepTreeProcessCwdHold(runId, path, keepHeld)) return
          const ownersBefore = evidenceOwningBranchOwners(ownerRow, p.path)
          const snapshot = safe.branch ? branchTip(p.path, safe.branch) : null
          const res = removeFor(w, p.path, false, ownersBefore.length > 0, runId)
          const sharersAfter = liveWorktreeSharers(db(), worktreeRow)
          const ownersAfter = evidenceOwningBranchOwners(ownerRow, p.path, snapshot)
          let ownershipRefusal: string | null = null
          let ownershipWarning: string | null = null
          if (safe.branch) {
            const outcome = verifyBranchOwnershipAfterCleanup(
              runId,
              p.path,
              safe.branch,
              snapshot,
              ownersBefore,
              ownersAfter,
            )
            ownershipRefusal = outcome.refusal
            ownershipWarning = outcome.warning
          }
          const afterRemoval = decideFilesystemOrphanAfterRemoval({
            sharers: sharersAfter.length,
            removed: res.removed,
            removeDetail: res.detail,
            ownershipRefusal,
            ownershipWarning,
          })
          const afterRemovalKeep = reportOrphanAfterRemovalKeep(
            afterRemoval,
            label,
            sharersAfter,
            keepHeld,
            options.presentation,
          )
          cleanupFailed ||= afterRemovalKeep.failed
          if (afterRemovalKeep.kept) return
          const finished = finishRemovedOrphan({
            runId,
            project: p,
            label,
            detail: res.detail,
            output: res.output,
            branch: safe.branch,
            ownersBefore,
            ownersAfter,
            inventoryErrors,
            leaked,
            keep,
            presentation: options.presentation,
          })
          cleanupFailed ||= finished.failed
          if (finished.released) closedCounts.released++
        })
      } catch (error) {
        cleanupFailed = true
        keepHeld(`${label}  removal refused`, 'removal refused')
        options.presentation.error(
          `could not reclaim ${label}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  for (const p of sweepProjects) {
    const tool = p.settings.worktree
    if (!tool?.sweep) continue
    const outcome = sweepProject({
      project: p,
      heldPaths: heldByProject.get(p.name) ?? new Set(),
      dryRun: dry,
      presentation: options.presentation,
    })
    cleanupFailed ||= outcome.failed
    if (outcome.keep) keep(outcome.keep.line, outcome.keep.reason)
  }

  const trustCleanupFailed = reclaimAbsentTrustEntries({
    dryRun: dry,
    selectedProject,
    headings: trustObservation.headings,
    pathFromHeading: helpers.grokTrustPathFromHeading,
    presentation: options.presentation,
  })
  cleanupFailed ||= trustCleanupFailed

  cleanupFailed ||= reclaimSweptDockerResources({
    dryRun: dry,
    selectedProject,
    presentation: options.presentation,
    inventoryErrors,
    leaked,
  })

  const branchCleanupFailed = pruneSweptProjectBranches({
    dryRun: dry,
    projects: sweepProjects,
    presentation: options.presentation,
  })
  cleanupFailed ||= branchCleanupFailed

  cleanupFailed ||= await sweepOrphanProcesses(sweepProjects, dry, options.presentation)

  printSweepKept(
    closedCounts.released,
    closedCounts.absent,
    closedCounts.forgotten,
    kept,
    dry,
    options.force,
    options.presentation,
  )
  await finishSweep(dry, cleanupFailed, helpers.hubTaskReader, options.presentation)
}
