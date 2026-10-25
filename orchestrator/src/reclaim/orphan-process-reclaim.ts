// concern: orphan process reclamation

import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  pidAlive,
  pidRecordIdentity,
  processSignalOutcome,
  processStartTime,
} from '../../../shared/process-identity.ts'
import { db, liveRuns } from '../database/db.ts'
import { isProjectRepository, projects } from '../project/projects.ts'
import {
  currentOrphanProcesses,
  type OrphanProcess,
  type ProcessFact,
} from '../resources/process-inventory.ts'

const ORPHAN_PROCESS_AUTO_RECLAIM_MIN_AGE_MS = 60_000
const RECLAIM_GRACE_MS = 5_000
type Identity = Pick<
  OrphanProcess,
  'pid' | 'startTime' | 'command' | 'missingTree' | 'match' | 'cwdVerified'
>

export function orphanProcessReverification(
  first: Identity,
  verified: Identity | null,
): { safe: true } | { safe: false; reason: string } {
  if (!first.startTime) return { safe: false, reason: `pid ${first.pid} start time is unknown` }
  if (!verified)
    return {
      safe: false,
      reason: `pid ${first.pid} is no longer attached to the same missing tree`,
    }
  if (first.match === 'cwd' && (!first.cwdVerified || !verified.cwdVerified))
    return { safe: false, reason: `pid ${first.pid} cwd process birth could not be verified` }
  if (!verified.startTime)
    return { safe: false, reason: `pid ${first.pid} start time became unknown` }
  if (verified.startTime !== first.startTime)
    return {
      safe: false,
      reason: `pid ${first.pid} start time changed from ${first.startTime} to ${verified.startTime}`,
    }
  if (verified.command !== first.command)
    return {
      safe: false,
      reason: `pid ${first.pid} command changed from ${first.command} to ${verified.command}`,
    }
  if (verified.missingTree !== first.missingTree)
    return {
      safe: false,
      reason: `pid ${first.pid} missing tree changed from ${first.missingTree} to ${verified.missingTree}`,
    }
  return { safe: true }
}

const platformProcess = (command: string) => {
  const words = command.toLowerCase().split(/[/\s]+/)
  return words.includes(PLATFORM_SLUG) || /orchestrator\/src\//.test(command)
}

export function automaticOrphanReclaimDecision(
  orphan: OrphanProcess,
  liveWorktrees: ReadonlySet<string>,
  removedByCurrentCleanup = false,
): { reclaim: true } | { reclaim: false; reason: string } {
  if (orphan.match !== 'cwd')
    return { reclaim: false, reason: 'argument-only match requires manual reclaim' }
  if (!orphan.cwdVerified)
    return { reclaim: false, reason: 'cwd process birth could not be verified' }
  if (platformProcess(orphan.command))
    return { reclaim: false, reason: `${PLATFORM_SLUG}/orchestrator lifecycle process` }
  if (liveWorktrees.has(orphan.missingTree))
    return { reclaim: false, reason: 'tree belongs to a live run' }
  if (!removedByCurrentCleanup && orphan.ageSeconds * 1000 < ORPHAN_PROCESS_AUTO_RECLAIM_MIN_AGE_MS)
    return {
      reclaim: false,
      reason: `younger than ${ORPHAN_PROCESS_AUTO_RECLAIM_MIN_AGE_MS}ms minimum age`,
    }
  if (orphan.runMarker === 'absent')
    return {
      reclaim: false,
      reason:
        'process carries neither the run delegation marker nor the run-process marker; reclaim it manually if it is residue',
    }
  if (orphan.runMarker === 'unknown')
    return {
      reclaim: false,
      reason: 'process environment could not be read to prove a run started it',
    }
  return { reclaim: true }
}

/** A run's recorded process group, paired with the tree that run used. */
export type RecordedRunProcessGroup = { worktree: string | null; agentPgid: number | null }

/**
 * Process-group evidence: a run records the group of the agent it launched, so
 * a candidate sharing that group *and* that tree is what the run left behind,
 * whatever its environment proves — which is how residue is still reclaimed on
 * a platform whose ps prints no environment at all. A gate or focused-test
 * child leads its own group, so the run-process marker the broker stamps on it
 * is what covers that one instead.
 */
export function applyRunProcessGroupEvidence(
  orphans: readonly OrphanProcess[],
  runs: readonly RecordedRunProcessGroup[],
): OrphanProcess[] {
  const groups = new Map<string, Set<number>>()
  for (const run of runs) {
    if (run.worktree === null || run.agentPgid === null) continue
    const tree = resolve(run.worktree)
    const pgids = groups.get(tree) ?? new Set<number>()
    pgids.add(run.agentPgid)
    groups.set(tree, pgids)
  }
  return orphans.map((orphan) =>
    orphan.runMarker !== 'present' && groups.get(resolve(orphan.missingTree))?.has(orphan.pgid)
      ? { ...orphan, runMarker: 'present' }
      : orphan,
  )
}

/** The process groups runs recorded, read in one query for the whole inventory. */
function recordedRunProcessGroups(): RecordedRunProcessGroup[] {
  const rows = db()
    .query('SELECT worktree, agent_pgid FROM run WHERE agent_pgid IS NOT NULL')
    .all() as { worktree: string | null; agent_pgid: number | null }[]
  return rows.map(({ worktree, agent_pgid }) => ({ worktree, agentPgid: agent_pgid }))
}

function descendants(root: number, facts: readonly ProcessFact[]): Set<number> {
  const found = new Set<number>()
  const pending = [root]
  while (pending.length) {
    const pid = pending.pop()!
    if (found.has(pid)) continue
    found.add(pid)
    for (const fact of facts) if (fact.ppid === pid) pending.push(fact.pid)
  }
  return found
}

export type OrphanSignalPlan = {
  targets: { pid: number; startTime: string | null }[]
}

export function orphanSignalPlan(
  root: OrphanProcess,
  facts: readonly ProcessFact[],
  births: ReadonlyMap<number, string | null>,
): OrphanSignalPlan {
  return {
    targets: [...descendants(root.pid, facts)]
      .sort((a, b) => b - a)
      .map((pid) => ({ pid, startTime: births.get(pid) ?? null })),
  }
}

type SignalPassAdapters = {
  freshPlan: (first: OrphanProcess) => ReturnType<typeof verifyAndPlan>
  identity: typeof pidRecordIdentity
  kill: typeof process.kill
}

export function signalFreshOrphanPlan(
  first: OrphanProcess,
  value: NodeJS.Signals,
  adapters: SignalPassAdapters = {
    freshPlan: verifyAndPlan,
    identity: pidRecordIdentity,
    kill: process.kill.bind(process),
  },
): { ok: true } | { ok: false; reason: string } {
  const fresh = adapters.freshPlan(first)
  if (!fresh.ok) return fresh
  for (const target of fresh.plan.targets) {
    if (adapters.identity(target.pid, target.startTime) !== 'live') continue
    try {
      adapters.kill(target.pid, value)
    } catch (error) {
      const outcome = processSignalOutcome(error)
      if (outcome === 'denied') {
        return {
          ok: false,
          reason: `pid ${target.pid} exists but this user may not signal it; rerun as the owning user`,
        }
      }
      if (outcome === 'unknown') throw error
    }
  }
  return { ok: true }
}

function verifyAndPlan(
  first: OrphanProcess,
): { ok: true; plan: OrphanSignalPlan } | { ok: false; reason: string } {
  const inventory = currentOrphanProcesses(projects().filter(isProjectRepository))
  if (inventory.error)
    return { ok: false, reason: `process inventory unavailable: ${inventory.error}` }
  const verified = inventory.orphans.find((item) => item.pid === first.pid) ?? null
  const identity = orphanProcessReverification(first, verified)
  if (!identity.safe) return { ok: false, reason: identity.reason }
  const liveIdentity = pidRecordIdentity(first.pid, first.startTime)
  if (liveIdentity !== 'live')
    return { ok: false, reason: `pid ${first.pid} identity is ${liveIdentity}` }
  const pids = [...descendants(verified!.pid, inventory.facts)]
  const births = new Map(
    pids.map((pid) => [pid, pid === first.pid ? first.startTime : processStartTime(pid)]),
  )
  return {
    ok: true,
    plan: orphanSignalPlan(verified!, inventory.facts, births),
  }
}

export function reclaimOrphanProcess(
  subject: string,
  dryRun: boolean,
): { ok: boolean; action: string } {
  const pid = Number(subject)
  if (!Number.isSafeInteger(pid) || pid <= 1)
    return { ok: false, action: `refused; invalid process id ${subject}` }
  const inventory = currentOrphanProcesses(projects().filter(isProjectRepository))
  if (inventory.error)
    return { ok: false, action: `refused; process inventory unavailable: ${inventory.error}` }
  const first = inventory.orphans.find((item) => item.pid === pid)
  if (first?.match === 'cwd' && !first.cwdVerified)
    return {
      ok: false,
      action: `refused; pid ${pid} cwd process birth could not be verified`,
    }
  if (!first?.startTime || pidRecordIdentity(pid, first.startTime) !== 'live')
    return {
      ok: false,
      action: `refused; pid ${pid} is not a re-verifiable orphan worktree process`,
    }
  const initial = verifyAndPlan(first)
  if (!initial.ok) return { ok: false, action: `refused; ${initial.reason}` }
  if (dryRun)
    return {
      ok: true,
      action: `would terminate pid ${pid} (${first.command}) for missing tree ${first.missingTree}`,
    }
  const terminated = signalFreshOrphanPlan(first, 'SIGTERM')
  if (!terminated.ok) return { ok: false, action: `refused; ${terminated.reason}` }
  const deadline = Date.now() + RECLAIM_GRACE_MS
  while (pidAlive(pid) && Date.now() < deadline) Bun.sleepSync(50)
  if (!pidAlive(pid))
    return {
      ok: true,
      action: `terminated orphan process tree rooted at pid ${pid} for missing tree ${first.missingTree}`,
    }
  const killed = signalFreshOrphanPlan(first, 'SIGKILL')
  if (!killed.ok) return { ok: false, action: `refused SIGKILL escalation; ${killed.reason}` }
  Bun.sleepSync(50)
  return pidAlive(pid)
    ? { ok: false, action: `refused; pid ${pid} process tree did not exit after SIGKILL` }
    : {
        ok: true,
        action: `terminated orphan process tree rooted at pid ${pid} for missing tree ${first.missingTree}`,
      }
}

export type RemovedTreeProcessCleanup = {
  reclaimed: string[]
  kept: { item: string; reason: string }[]
  errors: string[]
}

/** Reclaim cwd-owned processes for trees this operation itself has just removed. */
export function reclaimRemovedTreeProcesses(
  treePaths: readonly string[],
): RemovedTreeProcessCleanup {
  const removed = new Set(treePaths.map((path) => resolve(path)))
  const inventory = currentOrphanProcesses(projects().filter(isProjectRepository))
  const result: RemovedTreeProcessCleanup = { reclaimed: [], kept: [], errors: [] }
  if (inventory.error) result.errors.push(`process inventory unavailable: ${inventory.error}`)
  const liveWorktrees = liveRunWorktrees()
  const orphans = applyRunProcessGroupEvidence(inventory.orphans, recordedRunProcessGroups())
  const candidates = orphans.filter((orphan) => removed.has(resolve(orphan.missingTree)))
  const candidatePids = new Set(candidates.map(({ pid }) => pid))
  for (const orphan of candidates) {
    if (candidatePids.has(orphan.ppid)) continue
    const decision = automaticOrphanReclaimDecision(orphan, liveWorktrees, true)
    if (!decision.reclaim) {
      result.kept.push({ item: `process ${orphan.pid}`, reason: decision.reason })
      continue
    }
    const reclaimed = reclaimOrphanProcess(String(orphan.pid), false)
    if (reclaimed.ok) result.reclaimed.push(reclaimed.action)
    else result.errors.push(reclaimed.action)
  }
  return result
}

export function liveRunWorktrees(): Set<string> {
  return new Set(liveRuns().flatMap((row) => (row.worktree ? [row.worktree] : [])))
}
