/** Cleanup sweep knows worktree ownership, leases and the cleanup lock, resource reclamation, and branch retention. It must not know transports, routing, reviews, contracts, the CLI, or durable execution. */
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { pidAlive } from '../../../shared/process-identity.ts'
import { stampEndedClaims } from '../board/board-claim-service.ts'
import { reapBoardReach } from '../board/board-reach.ts'
import { reapBoardMessages } from '../board/board-service.ts'
import { closeOutRun, releaseSandboxDirectoryForConversation } from '../close/close-out.ts'
import { db, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { expireUnjudgedRun, unjudgedRuns } from '../evidence/unjudged-expiry.ts'
import { shouldSweepHookTree } from '../hook-tree/hook-tree.ts'
import { observeLandingTreeRelease } from '../landing-tree/release-observation.ts'
import {
  isProjectRepository,
  type Project,
  projectAt,
  projectByName,
  projects,
} from '../project/projects.ts'
import { type DockerResource, orchRunId } from '../resources/docker-resources.ts'
import { sweepIdleMainStacks } from '../resources/main-stack.ts'
import { liveWorktreeSharers } from '../resources/resource-ownership.ts'
import { runAlive } from '../run/run-alive.ts'
import { RUNS_DIR } from '../run/run-artifacts.ts'
import { auditRunMutation } from '../run/run-authority.ts'
import { removeFreeRunLease, runLeaseIds, runLeaseState } from '../run/run-lease.ts'
import { LANDING_TREE_JOB } from '../run/synthetic-lifecycle-job.ts'
import type { GrokTrustObservation } from '../sandbox/grok-trust.ts'
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
  decideFilesystemOrphanAfterInventory,
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
import { pruneSweptProjectBranches, reclaimAbsentTrustEntries } from './cleanup-sweep-reclaim.ts'
import { sweepUnattendedResidue } from './cleanup-sweep-residue.ts'
import { pruneReaderCloneArchives } from './reader-clone-archive-retention.ts'
import { sweepStrayWorktreeDirectories } from './stray-worktree-sweep.ts'

function reapExpiredBoardMessages(dryRun: boolean): void {
  if (!dryRun) {
    stampEndedClaims()
    reapBoardMessages()
    reapBoardReach(Date.now(), writableDb())
  }
}

export type SweepOptions = {
  dryRun: boolean
  project?: string
  force: boolean
  presentation: CleanupPresentation
}
export type SweepHelpers = {
  observeGrokTrustHeadings: () => GrokTrustObservation
  grokTrustPathFromHeading: (heading: string) => string | null
}

const KEPT_ROW_LIMIT = 10

type NamedRun = { id: number; status: string; alive: boolean }
type NamedRunLookup =
  | { outcome: 'absent' }
  | { outcome: 'owned'; run: NamedRun }
  | { outcome: 'unknown'; runId: number; reason: string }
type ClosedSweepOutcome = 'released' | 'absent' | 'forgotten'
type SweepCandidate = {
  id: number
  root_id: number
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
  launch_key: string | null
}
type ClosedSweepCounts = Record<ClosedSweepOutcome, number>

function namedRun(
  name: string,
  branchTemplate: string | undefined,
  project: Project,
): NamedRunLookup {
  const runId = worktreeNameRunId(name, branchTemplate)
  if (runId === null) return { outcome: 'absent' }
  const member = db()
    .query(
      `SELECT member.id, member.parent_run_id,
              member.project_record_id, root.project_record_id root_project_record_id
       FROM run member
       JOIN run root ON root.id=COALESCE(member.parent_run_id,member.id)
       WHERE member.id=?`,
    )
    .get(runId) as {
    id: number
    parent_run_id: number | null
    project_record_id: string | null
    root_project_record_id: string | null
  } | null
  if (!member) return { outcome: 'absent' }

  const rootId = member.parent_run_id ?? member.id
  if (member.root_project_record_id === null)
    return {
      outcome: 'unknown',
      runId: member.id,
      reason: `run ${member.id} root ${rootId} project UUID is missing`,
    }
  if (member.root_project_record_id !== project.recordId)
    return {
      outcome: 'unknown',
      runId: member.id,
      reason: `run ${member.id} root ${rootId} project UUID ${member.root_project_record_id} does not match project ${project.recordId}`,
    }
  if (member.project_record_id !== member.root_project_record_id)
    return {
      outcome: 'unknown',
      runId: member.id,
      reason: `run ${member.id} project UUID ${member.project_record_id ?? 'missing'} conflicts with root ${rootId} project UUID ${member.root_project_record_id}`,
    }
  const latest = db()
    .query(
      `SELECT id,status,pid FROM run
      WHERE id=? OR parent_run_id=?
      ORDER BY turn DESC, id DESC LIMIT 1`,
    )
    .get(rootId, rootId) as { id: number; status: string; pid: number | null }
  return {
    outcome: 'owned',
    run: {
      id: member.id,
      status: latest.status,
      alive: runAlive({
        status: latest.status,
        lease: runLeaseState(latest.id),
        pidAlive: Boolean(latest.pid && pidAlive(latest.pid)),
      }),
    },
  }
}

function namedRunAlive(lookup: NamedRunLookup): boolean {
  if (lookup.outcome === 'unknown') throw new Error(lookup.reason)
  return lookup.outcome === 'owned' && lookup.run.alive
}

function observeNamedRunForSweep(
  name: string,
  project: Project,
  label: string,
  presentation: CleanupPresentation,
): { alive: boolean; failed: boolean } {
  const lookup = namedRun(name, project.settings.worktree?.branch, project)
  if (lookup.outcome !== 'unknown') return { alive: namedRunAlive(lookup), failed: false }
  presentation.error(`could not reclaim ${label}: ${lookup.reason}`)
  return { alive: true, failed: true }
}

function conversationProjectOwnershipIssue(rootId: number): string | null {
  const members = db()
    .query(
      `SELECT id,project_record_id
       FROM run
       WHERE id=? OR parent_run_id=?
       ORDER BY id`,
    )
    .all(rootId, rootId) as { id: number; project_record_id: string | null }[]
  const root = members.find(({ id }) => id === rootId)
  if (!root || root.project_record_id === null)
    return `conversation root ${rootId} project UUID is missing; members ${members.map(({ id, project_record_id }) => `${id}=${project_record_id ?? 'missing'}`).join(', ')}`
  const conflicts = members.filter(
    ({ id, project_record_id }) => id !== rootId && project_record_id !== root.project_record_id,
  )
  if (conflicts.length === 0) return null
  return `conversation root ${rootId} project UUID ${root.project_record_id} conflicts with ${conflicts.map(({ id, project_record_id }) => `run ${id} UUID ${project_record_id ?? 'missing'}`).join(', ')}`
}

function sweepCandidateInProject(row: SweepCandidate, selectedProject: Project | null): boolean {
  if (!selectedProject) return true
  const members = db()
    .query('SELECT project_record_id FROM run WHERE id=? OR parent_run_id=?')
    .all(row.root_id, row.root_id) as { project_record_id: string | null }[]
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
  sandbox: { released: number; kept: number },
): void {
  presentation.log(
    `\n${dry ? 'would reclaim' : 'reclaimed'} ${released}, already absent ${absent}, forgotten ${forgotten}, kept ${kept.length}; ` +
      `${dry ? 'would release' : 'released'} sandbox ${sandbox.released}, kept sandbox ${sandbox.kept}`,
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

function directorySize(path: string): number {
  const entry = lstatSync(path)
  if (!entry.isDirectory()) return entry.size
  return readdirSync(path).reduce((total, name) => total + directorySize(join(path, name)), 0)
}

function sweepSandboxDirectories(
  dry: boolean,
  presentation: CleanupPresentation,
): { released: number; kept: number } {
  const counts = { released: 0, kept: 0 }
  if (!existsSync(RUNS_DIR)) return counts
  for (const entry of readdirSync(RUNS_DIR, { withFileTypes: true })) {
    const match = entry.isDirectory() ? /^sandbox-([1-9]\d*)$/.exec(entry.name) : null
    if (!match) continue
    const rootId = Number(match[1])
    const path = join(RUNS_DIR, entry.name)
    let bytes: number
    let result: ReturnType<typeof releaseSandboxDirectoryForConversation>
    try {
      bytes = directorySize(path)
      result = releaseSandboxDirectoryForConversation(rootId, { dryRun: dry })
    } catch (error) {
      counts.kept++
      presentation.log(`kept sandbox ${rootId}: ${String((error as Error).message ?? error)}`)
      continue
    }
    if (result.outcome === 'released') {
      counts.released++
      presentation.log(`${dry ? 'would release' : 'released'} sandbox ${rootId} ${bytes}`)
    } else {
      counts.kept++
      presentation.log(`kept sandbox ${rootId}: ${result.detail}`)
    }
  }
  return counts
}

function reportClosedSweepRow(
  outcome: ClosedSweepOutcome,
  row: { id: number; root_id: number; worktree: string | null },
  dry: boolean,
  presentation: CleanupPresentation,
): ClosedSweepOutcome {
  if (outcome === 'released' && !dry) {
    writeTransaction(() => {
      auditRunMutation(
        {
          runId: row.id,
          rootId: row.root_id,
          owner: null,
          actor: sessionId(),
          ownerLastSeenAt: null,
          chainLastActivityAt: Date.now(),
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
  presentation.log(`${action} ${row.id}  ${row.worktree}`)
  return outcome
}

function sweepTreeIsOwned(row: SweepCandidate): boolean {
  if (!row.worktree) return false
  const project = row.repo ? projectByName(row.repo) : projectAt(row.worktree)
  if (!project) return false
  const conversationIds = (
    db()
      .query('SELECT id FROM run WHERE id=? OR parent_run_id=? ORDER BY id')
      .all(row.root_id, row.root_id) as { id: number }[]
  ).map((turn) => turn.id)
  return (
    inspectTreeOwnership(
      row.worktree,
      project.path,
      conversationIds,
      project.settings.worktree?.branch,
    ) === 'owned'
  )
}

function shouldInventoryBeforeSweep(row: SweepCandidate, dry: boolean): boolean {
  return !dry && sweepTreeIsOwned(row)
}

function sweepTerminalRunLeases(dry: boolean): void {
  if (dry) return
  for (const runId of runLeaseIds()) {
    const row = db().query('SELECT status FROM run WHERE id=?').get(runId) as {
      status: string
    } | null
    if (row && ['ok', 'failed', 'stale', 'stopped'].includes(row.status)) {
      removeFreeRunLease(runId)
    }
  }
}

function sweepUnjudgedRuns(
  dry: boolean,
  selectedProject: { name: string } | null,
  presentation: CleanupPresentation,
): void {
  const now = Date.now()
  let expired = 0
  let kept = 0
  for (const row of unjudgedRuns(selectedProject?.name ?? null)) {
    const shouldExpire = shouldExpireUnjudgedOwner({
      ownerSessionId: row.session_id,
      ownerLastSeenAt: row.session_last_seen === null ? null : Date.parse(row.session_last_seen),
      runLastActivityAt: Date.parse(row.run_last_activity),
      now,
      windowMs: UNJUDGED_OWNER_WINDOW_MS,
    })
    if (!shouldExpire) {
      kept++
      continue
    }
    if (dry || expireUnjudgedRun(row, shouldExpireUnjudgedOwner, UNJUDGED_OWNER_WINDOW_MS)) {
      expired++
      presentation.log(`${dry ? 'would expire' : 'expired'} unjudged run ${row.id}`)
    } else {
      kept++
    }
  }
  presentation.log(`\n${dry ? 'would expire' : 'expired'} unjudged ${expired}, kept ${kept}`)
}

type RecordedSweepState = {
  cleanupFailed: boolean
  inventoryErrors: Set<string>
  leaked: Map<string, { resource: DockerResource; project: string; runId: number }>
  kept: { line: string; reason: string }[]
  counts: ClosedSweepCounts
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
      line: `${r.id}  inventory unavailable`,
      reason: ruling.keepReason!,
    })
    presentation.error(`could not verify reclaim ${r.id}: ${ruling.presentationError}`)
  } else if (ruling.action === 'leak') {
    for (const resource of resources)
      state.leaked.set(`${resource.kind}:${resource.name}`, {
        resource,
        project,
        runId: r.id,
      })
    state.kept.push({
      line: `${r.id}  leaked Docker resources`,
      reason: ruling.keepReason!,
    })
    presentation.error(
      `could not fully reclaim ${r.id}: project ${project}'s ${ruling.presentationError}`,
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
): void {
  const keep = (line: string, reason: string) => state.kept.push({ line, reason })
  const ownershipIssue = conversationProjectOwnershipIssue(r.root_id)
  if (ownershipIssue) {
    state.cleanupFailed = true
    keep(`${r.id}  ownership unknown: ${ownershipIssue}`, 'project ownership unknown')
    presentation.error(`could not reclaim ${r.id}: ${ownershipIssue}`)
    return
  }
  const current = db().query('SELECT worktree FROM run WHERE id=?').get(r.id) as {
    worktree: string | null
  } | null
  const pointerRuling = decideRecordedRunPointer({
    pointerUnchanged: current?.worktree === r.worktree,
  })
  if (pointerRuling.action === 'skip') return
  if (r.job === LANDING_TREE_JOB) {
    const landing = landingTreeSweepRuling(r)
    if (!landing.approved) {
      keep(`${r.id}  held: ${r.worktree}`, landing.reason)
      return
    }
  }
  let preInventory: 'unavailable' | 'ok' | 'not-needed' = 'not-needed'
  let preInventoryReason: string | null = null
  if (shouldInventoryBeforeSweep(r, dry)) {
    const before = resourcesForConversation(r.id)
    preInventory = before.ascertainable ? 'ok' : 'unavailable'
    preInventoryReason = before.ascertainable ? null : before.reason
  }
  const preInventoryRuling = decideRecordedRunPreInventory({
    inventory: preInventory,
  })
  if (preInventoryRuling.action === 'keep') {
    state.inventoryErrors.add(preInventoryReason!)
    state.cleanupFailed = preInventoryRuling.cleanupFailed
    keep(`${r.id}  inventory unavailable`, preInventoryRuling.keepReason)
    presentation.error(`could not verify reclaim ${r.id}: ${preInventoryRuling.presentationError}`)
    return
  }
  const closed = closeOutRun(r.id, {
    intent: 'sweep',
    dryRun: dry,
  })
  const closeRuling = decideRecordedRunCloseOut({
    dry,
    outcome: closed.outcome,
    detail: closed.detail,
  })
  if (closeRuling.action === 'report') {
    const outcome = reportClosedSweepRow(closed.outcome as ClosedSweepOutcome, r, dry, presentation)
    state.counts[outcome]++
    return
  }
  if (closeRuling.action === 'keep' || closeRuling.action === 'fail') {
    state.cleanupFailed ||= closeRuling.cleanupFailed
    keep(`${r.id}  ${closed.outcome}: ${closed.detail}`, closeRuling.keepReason)
    if (closeRuling.action === 'fail')
      presentation.error(`could not reclaim ${r.id}: ${closeRuling.presentationError}`)
    return
  }

  const inventory = resourcesForConversation(r.id)
  applyRecordedPostInventory(r, closeRuling.closeOutcome, inventory, state, presentation)
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
  const projectName = options.project
  const selectedProject = projectName === undefined ? null : projectByName(projectName)
  if (projectName !== undefined && !selectedProject)
    throw new Error(`unknown project ${projectName}`)
  const sweepProjects = (selectedProject ? [selectedProject] : projects()).filter(
    isProjectRepository,
  )
  if (!dry) writableDb()
  reapExpiredBoardMessages(dry)
  const archiveRetention = pruneReaderCloneArchives({
    dryRun: dry,
    presentation: options.presentation,
  })
  const trustObservation = helpers.observeGrokTrustHeadings()
  reconcileAbsentClaims({
    dryRun: dry,
    project: projectName,
    presentation: options.presentation,
    trust: trustObservation,
  })
  sweepUnjudgedRuns(dry, selectedProject, options.presentation)
  const rows = (
    db()
      .query(
        `SELECT r.id, COALESCE(r.parent_run_id, r.id) root_id,
              r.repo, r.project_record_id, r.worktree, r.branch, r.base_commit, r.worktree_source, r.status, r.job,
              r.pid, r.agent_pid, r.session_id, seen.last_seen AS session_last_seen,
              r.launch_key, r.close_out_outcome
         FROM run r
         LEFT JOIN session_seen seen ON seen.session_id=r.session_id
        WHERE r.status IN ('ok','failed','stale','stopped')
        ORDER BY r.id`,
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

  const { removeFor, sweepWithTool } = await import('../worktree/worktree-remove.ts')

  const closedCounts: ClosedSweepCounts = {
    released: 0,
    absent: 0,
    forgotten: 0,
  }
  let cleanupFailed = archiveRetention.failed > 0
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
  const leaked = new Map<string, { resource: DockerResource; project: string; runId: number }>()
  const kept: { line: string; reason: string }[] = []
  const keep = (line: string, reason: string) => {
    kept.push({ line, reason })
  }
  const recordedState: RecordedSweepState = {
    cleanupFailed,
    inventoryErrors,
    leaked,
    kept,
    counts: closedCounts,
  }
  sweepTerminalRunLeases(dry)
  for (const r of rows) sweepRecordedRow(r, dry, recordedState, options.presentation)
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
  const remembered = new Set(
    (
      db().query('SELECT worktree FROM run WHERE worktree IS NOT NULL').all() as {
        worktree: string
      }[]
    ).map((r) => (existsSync(r.worktree) ? realpathSync(r.worktree) : r.worktree)),
  )
  for (const p of sweepProjects) {
    const root = join(p.path, '.claude', 'worktrees')
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(root, entry.name)
      if (remembered.has(realpathSync(path))) continue

      const label = `orphan  ${path}`
      const named = observeNamedRunForSweep(entry.name, p, label, options.presentation)
      cleanupFailed ||= named.failed
      const trunk =
        typeof p.settings.trunk === 'string' && p.settings.trunk.trim() ? p.settings.trunk : 'HEAD'
      const safe = orphanSafety(path, p.path, trunk)
      const eligibilityRuling = decideFilesystemOrphanEligibility({
        orchOwned: isOrchWorktree(path, p.settings.worktree?.branch),
        alive: named.alive,
        safe,
        dry,
      })
      if (eligibilityRuling.action === 'keep') {
        keep(`${label}  ${eligibilityRuling.keepLine}`, eligibilityRuling.keepReason)
        continue
      }
      if (eligibilityRuling.action === 'dry-would-reclaim') {
        options.presentation.log(`would reclaim ${label}; ${safe.detail}`)
        closedCounts.released++
        continue
      }

      const source = markedWorktreeSource(path)
      const w = {
        path,
        branch: safe.branch,
        base: '',
        repoRoot: p.path,
        source,
        mintedBranch: safe.branch,
      }
      const runId = orchRunId(entry.name)
      try {
        withCleanupLock(p.path, `sweep ${label}`, path, () => {
          const ownerRow = {
            id: runId ?? -1,
            repo: p.name,
            branch: safe.branch,
          }
          const worktreeRow = { id: runId ?? -1, worktree: path }
          const sharersBefore = liveWorktreeSharers(db(), worktreeRow)
          const lockedRun = namedRun(entry.name, p.settings.worktree?.branch, p)
          const lockedRuling = decideFilesystemOrphanUnderLock({
            sharers: sharersBefore.length,
            lockedAlive: namedRunAlive(lockedRun),
          })
          if (lockedRuling.action === 'shared-before') {
            const owners = sharersBefore.map((owner) => `${owner.id} (${owner.status})`).join(', ')
            cleanupFailed ||= lockedRuling.cleanupFailed
            keep(`${label}  ${lockedRuling.keepLine}: ${owners}`, lockedRuling.keepReason!)
            options.presentation.error(`could not reclaim ${label}: acquired by run(s) ${owners}`)
            return
          }
          if (lockedRuling.action === 'live') {
            keep(`${label}  ${lockedRuling.keepLine}`, lockedRuling.keepReason!)
            return
          }
          const ownersBefore = evidenceOwningBranchOwners(ownerRow, p.path)
          const snapshot = safe.branch ? branchTip(p.path, safe.branch) : null
          const res = removeFor(w, p.path, false, ownersBefore.length > 0, runId ?? undefined)
          const sharersAfter = liveWorktreeSharers(db(), worktreeRow)
          const ownersAfter = evidenceOwningBranchOwners(ownerRow, p.path, snapshot)
          let ownershipRefusal: string | null = null
          let ownershipWarning: string | null = null
          if (safe.branch) {
            const outcome = verifyBranchOwnershipAfterCleanup(
              runId ?? -1,
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
          if (afterRemoval.ownershipWarning)
            options.presentation.error(`${label}: ${afterRemoval.ownershipWarning}`)
          if (afterRemoval.action === 'removal-refused') {
            cleanupFailed ||= afterRemoval.cleanupFailed
            keep(`${label}  ${afterRemoval.keepLine}`, afterRemoval.keepReason!)
            options.presentation.error(`could not reclaim ${label}: ${afterRemoval.error}`)
            return
          }
          if (afterRemoval.action === 'shared-after') {
            const owners = sharersAfter.map((owner) => `${owner.id} (${owner.status})`).join(', ')
            cleanupFailed ||= afterRemoval.cleanupFailed
            keep(`${label}  ${afterRemoval.keepLine}: ${owners}`, afterRemoval.keepReason!)
            options.presentation.error(
              `could not reclaim ${label}: acquired during cleanup by run(s) ${owners}`,
            )
            return
          }
          const inventory =
            runId === null
              ? { ascertainable: true as const, resources: [] }
              : resourcesForConversation(runId)
          const inventoryReason = inventory.ascertainable ? null : inventory.reason
          const resources = inventory.ascertainable ? inventory.resources : []
          const inventoryFact = !inventory.ascertainable
            ? ('unavailable' as const)
            : resources.length
              ? ('leaked' as const)
              : ('empty' as const)
          const finalRuling = decideFilesystemOrphanAfterInventory({
            runIdPresent: runId !== null,
            inventory: inventoryFact,
          })
          cleanupFailed ||= finalRuling.cleanupFailed
          if (finalRuling.action === 'inventory-unavailable') {
            inventoryErrors.add(inventoryReason!)
            keep(`${label}  ${finalRuling.keepLine}`, finalRuling.keepReason)
            return
          }
          const left = resources
          if (finalRuling.action === 'leaked') {
            for (const resource of left)
              leaked.set(`${resource.kind}:${resource.name}`, {
                resource,
                project: p.name,
                runId: resource.runId,
              })
            keep(`${label}  ${finalRuling.keepLine}`, finalRuling.keepReason!)
          } else {
            options.presentation.log(`reclaimed ${label}  ${res.detail}`)
            if (res.output) options.presentation.log(res.output)
            const owner = ownersAfter[0] ?? ownersBefore[0] ?? null
            if (owner && safe.branch) {
              options.presentation.log(
                `branch ${safe.branch} left because run ${owner.id} records it`,
              )
            }
            closedCounts.released++
          }
        })
      } catch (error) {
        cleanupFailed = true
        keep(`${label}  removal refused`, 'removal refused')
        options.presentation.error(
          `could not reclaim ${label}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  /**
   * Then the PROJECT'S OWN sweep, which knows what orch cannot.
   *
   * A database whose worktree directory was deleted by hand is invisible to
   * everything above — no row points at it, and there is nothing left to
   * remove. Each project's tool is the only thing that can find those, and
   * running it is the difference between reclaiming directories and
   * reclaiming disk.
   */
  if (!dry) {
    for (const p of sweepProjects) {
      const tool = p.settings.worktree
      if (!tool?.sweep) continue
      let result: ReturnType<typeof sweepWithTool>
      try {
        result = withCleanupLock(p.path, `project sweep for ${p.name}`, null, () =>
          sweepWithTool(tool, p.path),
        )
      } catch (error) {
        cleanupFailed = true
        options.presentation.error(
          `project ${p.name} sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        continue
      }
      if (!result) continue
      if (result.out.trim()) {
        const lines = result.out.trim().split('\n')
        const omitted = Math.max(0, lines.length - 8)
        options.presentation.log(`\n${p.name} sweep:\n${lines.slice(-8).join('\n')}`)
        if (omitted) {
          options.presentation.log(`  (${omitted} earlier line${omitted === 1 ? '' : 's'} omitted)`)
        }
      }
      if (!result.ok) {
        cleanupFailed = true
        options.presentation.error(
          `project ${p.name} sweep failed with exit status ${result.exitCode ?? 'unknown'}`,
        )
      }
    }
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

  const sandboxCounts = sweepSandboxDirectories(dry, options.presentation)

  const branchCleanupFailed = pruneSweptProjectBranches({
    dryRun: dry,
    projects: sweepProjects,
    presentation: options.presentation,
  })
  cleanupFailed ||= branchCleanupFailed

  printSweepKept(
    closedCounts.released,
    closedCounts.absent,
    closedCounts.forgotten,
    kept,
    dry,
    options.force,
    options.presentation,
    sandboxCounts,
  )
  if (cleanupFailed) options.presentation.setExitCode(1)
}
