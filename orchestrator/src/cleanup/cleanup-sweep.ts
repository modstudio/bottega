/** Cleanup sweep knows worktree ownership, leases and the cleanup lock, resource reclamation, and branch retention. It must not know transports, routing, reviews, contracts, the CLI, or durable execution. */
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { closeOutRun, releaseSandboxDirectoryForConversation } from '../close/close-out.ts'
import { db, sessionId, writableDb, writeTransaction } from '../db.ts'
import {
  classifiedDockerResources,
  type DockerResource,
  dockerRunResources,
  leakedResourceLines,
  orchRunId,
} from '../docker-resources.ts'
import { shouldSweepHookTree } from '../hook-tree.ts'
import { pidAlive } from '../process-liveness.ts'
import { projectAt, projectByName, projects } from '../projects.ts'
import { liveWorktreeSharers, terminalDockerRetentionReasonForRun } from '../resource-ownership.ts'
import { runAlive } from '../run-alive.ts'
import { RUNS_DIR } from '../run-artifacts.ts'
import { auditRunMutation } from '../run-authority.ts'
import { removeFreeRunLease, runLeaseIds, runLeaseState } from '../run-lease.ts'
import {
  inspectTreeOwnership,
  isOrchWorktree,
  markedWorktreeSource,
  orphanSafety,
  worktreeNameRunId,
} from '../worktree-attribution.ts'
import { branchTip } from '../worktree-remove.ts'
import type { Worktree } from '../worktree-types.ts'
import {
  type CleanupPresentation,
  evidenceOwningBranchOwners,
  resourcesForConversation,
  verifyBranchOwnershipAfterCleanup,
  withCleanupLock,
} from './cleanup.ts'

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

function orphanKeepReason(detail: string): string {
  return /^has commits not reachable from /.test(detail) ? 'holds commits not on trunk' : detail
}

type NamedRun = { id: number; status: string; alive: boolean }
type ClosedSweepOutcome = 'released' | 'absent' | 'forgotten'
type SweepCandidate = {
  id: number
  root_id: number
  repo: string | null
  worktree: string
  branch: string | null
  base_commit: string | null
  status: string
  worktree_source: Worktree['source'] | null
  job: string
  pid: number | null
  agent_pid: number | null
  session_id: string | null
  session_last_seen: string | null
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
  row: { id: number; root_id: number; worktree: string },
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

function reportImmediateClosedSweep(
  closed: ReturnType<typeof closeOutRun>,
  row: SweepCandidate,
  dry: boolean,
  counts: ClosedSweepCounts,
  presentation: CleanupPresentation,
): boolean {
  if (!dry && closed.outcome !== 'forgotten') return false
  if (!['released', 'absent', 'forgotten'].includes(closed.outcome)) return false
  const outcome = reportClosedSweepRow(closed.outcome as ClosedSweepOutcome, row, dry, presentation)
  counts[outcome]++
  return true
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
  const rows = (
    db()
      .query(
        `SELECT r.id, COALESCE(r.parent_run_id, r.id) root_id,
              r.repo, r.worktree, r.branch, r.base_commit, r.worktree_source, r.status, r.job,
              r.pid, r.agent_pid, r.session_id, seen.last_seen AS session_last_seen
         FROM run r
         LEFT JOIN session_seen seen ON seen.session_id=r.session_id
        WHERE r.worktree IS NOT NULL AND r.status IN ('ok','failed','stale','stopped')
        ORDER BY r.id`,
      )
      .all() as SweepCandidate[]
  )
    .filter(shouldSweepHookTree)
    .filter((row) => !selectedProject || projectAt(row.worktree)?.name === selectedProject.name)

  const { removeFor, sweepWithTool } = await import('../worktree-remove.ts')

  const closedCounts: ClosedSweepCounts = { released: 0, absent: 0, forgotten: 0 }
  let cleanupFailed = false
  const inventoryErrors = new Set<string>()
  const leaked = new Map<string, { resource: DockerResource; project: string; runId: number }>()
  const kept: { line: string; reason: string }[] = []
  const keep = (line: string, reason: string) => {
    kept.push({ line, reason })
  }
  sweepTerminalRunLeases(dry)
  for (const r of rows) {
    const current = db().query('SELECT worktree FROM run WHERE id=?').get(r.id) as {
      worktree: string | null
    } | null
    if (current?.worktree !== r.worktree) continue
    if (shouldInventoryBeforeSweep(r, dry)) {
      const before = resourcesForConversation(r.id)
      if (!before.ascertainable) {
        inventoryErrors.add(before.reason)
        cleanupFailed = true
        keep(`${r.id}  inventory unavailable`, 'inventory unavailable')
        options.presentation.error(`could not verify reclaim ${r.id}: inventory unavailable`)
        continue
      }
    }
    const closed = closeOutRun(r.id, { intent: 'sweep', dryRun: dry })
    if (reportImmediateClosedSweep(closed, r, dry, closedCounts, options.presentation)) continue
    if (closed.outcome === 'released' || closed.outcome === 'absent') {
      const project = r.repo ?? projectAt(r.worktree)?.name ?? 'unknown'
      const inventory = resourcesForConversation(r.id)
      if (!inventory.ascertainable) {
        inventoryErrors.add(inventory.reason)
        cleanupFailed = true
        keep(`${r.id}  inventory unavailable`, 'inventory unavailable')
        options.presentation.error(`could not verify reclaim ${r.id}: inventory unavailable`)
      } else if (inventory.resources.length) {
        cleanupFailed = true
        for (const resource of inventory.resources)
          leaked.set(`${resource.kind}:${resource.name}`, {
            resource,
            project,
            runId: r.id,
          })
        keep(`${r.id}  leaked Docker resources`, 'leaked Docker resources')
        options.presentation.error(
          `could not fully reclaim ${r.id}: project ${project}'s remove tool leaked Docker resources`,
        )
      } else {
        const outcome = reportClosedSweepRow(closed.outcome, r, false, options.presentation)
        closedCounts[outcome]++
      }
    } else {
      const reason = closed.detail.startsWith('held by explicit --keep-tree')
        ? 'held by explicit --keep-tree; clear with orch discard <run-id>'
        : closed.detail
      keep(`${r.id}  ${closed.outcome}: ${closed.detail}`, reason)
      if (closed.outcome === 'failed') {
        cleanupFailed = true
        options.presentation.error(`could not reclaim ${r.id}: ${closed.detail}`)
      }
    }
  }

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
      if (!isOrchWorktree(path, p.settings.worktree?.branch)) {
        keep(`${label}  kept: not created by orch`, 'not created by orch')
        continue
      }
      const named = namedRun(entry.name, p.settings.worktree?.branch, p)
      if (named?.alive) {
        keep(`${label}  live — kept`, 'live — kept')
        continue
      }
      const trunk =
        typeof p.settings.trunk === 'string' && p.settings.trunk.trim() ? p.settings.trunk : 'HEAD'
      const safe = orphanSafety(path, p.path, trunk)
      if (!safe.removable) {
        keep(`${label}  ${safe.detail}`, orphanKeepReason(safe.detail))
        continue
      }
      if (dry) {
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
          const ownerRow = { id: runId ?? -1, repo: p.name, branch: safe.branch }
          const worktreeRow = { id: runId ?? -1, worktree: path }
          const sharersBefore = liveWorktreeSharers(db(), worktreeRow)
          if (sharersBefore.length) {
            const owners = sharersBefore.map((owner) => `${owner.id} (${owner.status})`).join(', ')
            cleanupFailed = true
            keep(`${label}  acquired by run(s): ${owners}`, 'shared with live run(s)')
            options.presentation.error(`could not reclaim ${label}: acquired by run(s) ${owners}`)
            return
          }
          const ownersBefore = evidenceOwningBranchOwners(ownerRow, p.path)
          const snapshot = safe.branch ? branchTip(p.path, safe.branch) : null
          const lockedRun = namedRun(entry.name, p.settings.worktree?.branch, p)
          if (lockedRun?.alive) {
            keep(`${label}  live — kept`, 'live — kept')
            return
          }
          const res = removeFor(w, p.path, false, ownersBefore.length > 0, runId ?? undefined)
          const sharersAfter = liveWorktreeSharers(db(), worktreeRow)
          const ownersAfter = evidenceOwningBranchOwners(ownerRow, p.path, snapshot)
          if (safe.branch) {
            const outcome = verifyBranchOwnershipAfterCleanup(
              runId ?? -1,
              p.path,
              safe.branch,
              snapshot,
              ownersBefore,
              ownersAfter,
            )
            if (outcome.warning) options.presentation.error(`${label}: ${outcome.warning}`)
            if (outcome.refusal) {
              cleanupFailed = true
              keep(`${label}  removal refused`, 'removal refused')
              options.presentation.error(`could not reclaim ${label}: ${outcome.refusal}`)
              return
            }
          }
          if (sharersAfter.length) {
            const owners = sharersAfter.map((owner) => `${owner.id} (${owner.status})`).join(', ')
            cleanupFailed = true
            keep(
              `${label}  acquired during cleanup by run(s): ${owners}`,
              'shared with live run(s)',
            )
            options.presentation.error(
              `could not reclaim ${label}: acquired during cleanup by run(s) ${owners}`,
            )
            return
          }
          if (res.removed) {
            const inventory =
              runId === null
                ? { ascertainable: true as const, resources: [] }
                : resourcesForConversation(runId)
            if (!inventory.ascertainable) {
              inventoryErrors.add(inventory.reason)
              cleanupFailed = true
              keep(`${label}  inventory unavailable`, 'inventory unavailable')
              return
            }
            const left = inventory.resources
            if (left.length) {
              cleanupFailed = true
              for (const resource of left)
                leaked.set(`${resource.kind}:${resource.name}`, {
                  resource,
                  project: p.name,
                  runId: resource.runId,
                })
              keep(`${label}  leaked Docker resources`, 'leaked Docker resources')
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
          } else {
            cleanupFailed = true
            keep(`${label}  removal refused`, 'removal refused')
            options.presentation.error(`could not reclaim ${label}: ${res.detail}`)
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

  const trustRuns = db()
    .query('SELECT id, mcp_trust_path FROM run WHERE mcp_trust_path IS NOT NULL ORDER BY id')
    .all() as { id: number; mcp_trust_path: string }[]
  const trustOwners = new Map<string, number>()
  for (const run of trustRuns) {
    try {
      const headings = JSON.parse(run.mcp_trust_path) as unknown
      if (!Array.isArray(headings)) continue
      for (const heading of headings) {
        if (typeof heading === 'string' && !trustOwners.has(heading)) {
          trustOwners.set(heading, run.id)
        }
      }
    } catch {
      /* observation from an older or incomplete row is not authority */
    }
  }
  for (const heading of helpers.grokTrustHeadings()) {
    const path = helpers.grokTrustPathFromHeading(heading)
    if (!path || existsSync(path)) continue
    if (
      selectedProject &&
      path !== selectedProject.path &&
      !path.startsWith(`${selectedProject.path}/`)
    )
      continue
    const runId = trustOwners.get(heading)
    options.presentation.log(
      `grok trust entry for absent path ${path}${runId ? ` (run ${runId})` : ''}; prune by hand`,
    )
  }

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
    db().query('SELECT id, repo, worktree, status FROM run').all() as {
      id: number
      repo: string | null
      worktree: string | null
      status: string
    }[]
  ).map((owner) => ({
    ...owner,
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
