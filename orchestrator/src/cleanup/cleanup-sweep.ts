/** Cleanup sweep knows worktree ownership, leases and the cleanup lock, resource reclamation, and branch retention. It must not know transports, routing, reviews, contracts, the CLI, or durable execution. */
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pidAlive } from '../../../shared/process-identity.ts'
import { closeOutRun, releaseSandboxDirectoryForConversation } from '../close/close-out.ts'
import { db, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { expireUnjudgedRun, unjudgedRuns } from '../evidence/unjudged-expiry.ts'
import { shouldSweepHookTree } from '../hook-tree/hook-tree.ts'
import { observeLandingTreeRelease } from '../landing-tree/release-observation.ts'
import {
  absentTreeTeardownPlan,
  projectAt,
  projectByName,
  projects,
  resolvedWorktreeTool,
} from '../project/projects.ts'
import {
  classifiedDockerResources,
  type DockerResource,
  dockerRunResources,
  leakedResourceLines,
  orchRunId,
} from '../resources/docker-resources.ts'
import {
  liveWorktreeSharers,
  terminalDockerRetentionReasonForRun,
} from '../resources/resource-ownership.ts'
import { runAlive } from '../run/run-alive.ts'
import { RUNS_DIR } from '../run/run-artifacts.ts'
import { auditRunMutation } from '../run/run-authority.ts'
import { removeFreeRunLease, runLeaseIds, runLeaseState } from '../run/run-lease.ts'
import { LANDING_TREE_JOB } from '../run/synthetic-lifecycle-job.ts'
import {
  inspectTreeOwnership,
  isOrchWorktree,
  markedWorktreeSource,
  orphanSafety,
  worktreeNameRunId,
} from '../worktree/worktree-attribution.ts'
import { branchTip } from '../worktree/worktree-remove.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
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
import { pruneSweptProjectBranches, reclaimAbsentTrustEntries } from './cleanup-sweep-reclaim.ts'

export type SweepOptions = {
  dryRun: boolean
  project?: string
  force: boolean
  presentation: CleanupPresentation
}
export type SweepHelpers = {
  grokTrustHeadings: () => string[]
  grokTrustPathFromHeading: (heading: string) => string | null
}

const KEPT_ROW_LIMIT = 10

type NamedRun = { id: number; status: string; alive: boolean }
type ClosedSweepOutcome = 'released' | 'absent' | 'forgotten'
type SweepCandidate = {
  id: number
  root_id: number
  repo: string | null
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

function pathIsUnder(path: string | null, root: string): boolean {
  if (!path) return false
  const candidate = resolve(path)
  const project = resolve(root)
  return candidate === project || candidate.startsWith(`${project}/`)
}

function namedRun(
  name: string,
  branchTemplate: string | undefined,
  project: { name: string; path: string },
): NamedRun | null {
  const runId = worktreeNameRunId(name, branchTemplate)
  if (runId === null) return null
  const member = db()
    .query('SELECT id, parent_run_id, repo, cwd, worktree FROM run WHERE id=?')
    .get(runId) as {
    id: number
    parent_run_id: number | null
    repo: string | null
    cwd: string | null
    worktree: string | null
  } | null
  if (!member) return null
  const belongs =
    member.repo === project.name ||
    (member.repo === null &&
      (pathIsUnder(member.cwd, project.path) || pathIsUnder(member.worktree, project.path)))
  if (!belongs) return null

  const rootId = member.parent_run_id ?? member.id
  const latest = db()
    .query(
      `SELECT id,status,pid FROM run
      WHERE id=? OR parent_run_id=?
      ORDER BY turn DESC, id DESC LIMIT 1`,
    )
    .get(rootId, rootId) as { id: number; status: string; pid: number | null }
  return {
    id: member.id,
    status: latest.status,
    alive: runAlive({
      status: latest.status,
      lease: runLeaseState(latest.id),
      pidAlive: Boolean(latest.pid && pidAlive(latest.pid)),
    }),
  }
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
    const parts = ['orch sweep --dry-run']
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
        { runId: row.id, rootId: row.root_id, owner: null, actor: sessionId() },
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
  })
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
  const closed = closeOutRun(r.id, { intent: 'sweep', dryRun: dry })
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
  const sweepProjects = selectedProject ? [selectedProject] : projects()
  if (!dry) writableDb()
  sweepUnjudgedRuns(dry, selectedProject, options.presentation)
  const rows = (
    db()
      .query(
        `SELECT r.id, COALESCE(r.parent_run_id, r.id) root_id,
              r.repo, r.worktree, r.branch, r.base_commit, r.worktree_source, r.status, r.job,
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
    .filter(
      (row) =>
        !selectedProject ||
        row.repo === selectedProject.name ||
        Boolean(row.worktree && projectAt(row.worktree)?.name === selectedProject.name),
    )

  const { removeFor, sweepWithTool } = await import('../worktree/worktree-remove.ts')

  const closedCounts: ClosedSweepCounts = {
    released: 0,
    absent: 0,
    forgotten: 0,
  }
  let cleanupFailed = false
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
  cleanupFailed = recordedState.cleanupFailed

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
      const named = namedRun(entry.name, p.settings.worktree?.branch, p)
      const trunk =
        typeof p.settings.trunk === 'string' && p.settings.trunk.trim() ? p.settings.trunk : 'HEAD'
      const safe = orphanSafety(path, p.path, trunk)
      const eligibilityRuling = decideFilesystemOrphanEligibility({
        orchOwned: isOrchWorktree(path, p.settings.worktree?.branch),
        alive: Boolean(named?.alive),
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
            lockedAlive: Boolean(lockedRun?.alive),
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
    headings: helpers.grokTrustHeadings(),
    pathFromHeading: helpers.grokTrustPathFromHeading,
    presentation: options.presentation,
  })
  cleanupFailed ||= trustCleanupFailed

  // Inventory is a read, so dry-run performs it too. A preview that omits
  // already-leaked infrastructure is materially cleaner than the real run.
  const inventory = dockerRunResources()
  if (!inventory.ascertainable) {
    inventoryErrors.add(inventory.reason)
    cleanupFailed = true
  }
  const inventoryResources = inventory.ascertainable ? inventory.resources : []
  const inventoryOwnerIds = new Set(inventoryResources.map(({ runId }) => runId))
  const owners = (
    db()
      .query(
        `SELECT r.id,COALESCE(root.repo,r.repo) repo,r.worktree,r.status,
                COALESCE(root.worktree_source,r.worktree_source) worktree_source,
                COALESCE(root.recipe_snapshot,r.recipe_snapshot) recipe_snapshot,
                COALESCE(root.resource_teardown,r.resource_teardown) resource_teardown
         FROM run r LEFT JOIN run root ON root.id=r.parent_run_id`,
      )
      .all() as {
      id: number
      repo: string | null
      worktree: string | null
      status: string
      worktree_source: Worktree['source'] | null
      recipe_snapshot: string | null
      resource_teardown: 'pending' | 'done' | null
    }[]
  ).map((owner) => ({
    ...owner,
    absentTreeTeardown:
      Boolean(owner.worktree && !existsSync(owner.worktree)) &&
      absentTreeTeardownPlan({
        recipeSnapshot: owner.recipe_snapshot,
        worktreeSource: owner.worktree_source,
        resourceTeardown: owner.resource_teardown,
        registeredRemoveCommand: Boolean(
          resolvedWorktreeTool(owner.repo ? projectByName(owner.repo) : null)?.remove,
        ),
      }),
    retentionReason: inventoryOwnerIds.has(owner.id)
      ? terminalDockerRetentionReasonForRun(db(), owner.id)
      : null,
  }))
  const classified = classifiedDockerResources(inventoryResources, owners).filter(
    (item) => !selectedProject || item.project === selectedProject.name,
  )
  for (const { resource, project, condition } of classified) {
    if (condition === 'retained-worktree-resources') continue
    const key = `${resource.kind}:${resource.name}`
    if (!leaked.has(key)) leaked.set(key, { resource, project, runId: resource.runId })
  }
  const retained = classified.filter(({ condition }) => condition === 'retained-worktree-resources')
  if (retained.length) {
    options.presentation.error(
      `\n${dry ? 'would report ' : ''}retained worktree Docker resources: ${retained.length}`,
    )
    for (const { resource, project, reason } of retained) {
      options.presentation.error(
        `  ${resource.kind} ${resource.name} re-served or retained by project ${project} (run ${resource.runId}); ${reason ? `removal could not be ascertained: ${reason}; ` : ''}no removal suggested`,
      )
    }
  }
  if (leaked.size) {
    cleanupFailed = true
    options.presentation.error(
      `\n${dry ? 'would report ' : ''}leaked Docker resources: ${leaked.size}`,
    )
    for (const { resource, project } of leaked.values()) {
      options.presentation.error(
        `  ${dry ? 'would report ' : ''}${leakedResourceLines([resource], project)[0]}`,
      )
    }
  }
  if (inventoryErrors.size) {
    options.presentation.error(
      `\n${dry ? 'would report ' : ''}inventory unavailable: ${inventoryErrors.size}`,
    )
    for (const error of inventoryErrors)
      options.presentation.error(`  ${dry ? 'would report ' : ''}${error}`)
  }

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
  return
}
