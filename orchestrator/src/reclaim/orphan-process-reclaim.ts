// concern: orphan process reclamation
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { pidAlive, pidRecordIdentity } from '../../../shared/process-identity.ts'
import { liveRuns } from '../database/db.ts'
import { isProjectRepository, projects } from '../project/projects.ts'
import {
  currentOrphanProcesses,
  type OrphanProcess,
  type ProcessFact,
} from '../resources/process-inventory.ts'

const ORPHAN_PROCESS_AUTO_RECLAIM_MIN_AGE_MS = 60_000
const RECLAIM_GRACE_MS = 5_000
type Identity = Pick<OrphanProcess, 'pid' | 'startTime' | 'command' | 'missingTree'>

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
  return (
    words.includes(PLATFORM_SLUG) || words.includes('orch') || /orchestrator\/src\//.test(command)
  )
}

export function automaticOrphanReclaimDecision(
  orphan: OrphanProcess,
  liveWorktrees: ReadonlySet<string>,
): { reclaim: true } | { reclaim: false; reason: string } {
  if (orphan.match !== 'cwd')
    return { reclaim: false, reason: 'argument-only match requires manual reclaim' }
  if (platformProcess(orphan.command))
    return { reclaim: false, reason: `${PLATFORM_SLUG}/orch lifecycle process` }
  if (liveWorktrees.has(orphan.missingTree))
    return { reclaim: false, reason: 'tree belongs to a live run' }
  if (orphan.ageSeconds * 1000 < ORPHAN_PROCESS_AUTO_RECLAIM_MIN_AGE_MS)
    return {
      reclaim: false,
      reason: `younger than ${ORPHAN_PROCESS_AUTO_RECLAIM_MIN_AGE_MS}ms minimum age`,
    }
  return { reclaim: true }
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

export type OrphanSignalPlan = { kind: 'group'; pgid: number } | { kind: 'pids'; pids: number[] }

export function orphanSignalPlan(
  root: OrphanProcess,
  facts: readonly ProcessFact[],
  orphans: readonly OrphanProcess[],
  callerPgid: number | null,
): OrphanSignalPlan {
  const tree = descendants(root.pid, facts)
  const sameTreeOrphans = new Set(
    orphans.filter((item) => item.missingTree === root.missingTree).map((item) => item.pid),
  )
  const group = facts.filter((fact) => fact.pgid === root.pgid)
  const groupSafe =
    root.pgid > 1 &&
    root.pgid !== callerPgid &&
    group.length > 0 &&
    group.every((fact) => tree.has(fact.pid) || sameTreeOrphans.has(fact.pid))
  return groupSafe
    ? { kind: 'group', pgid: root.pgid }
    : { kind: 'pids', pids: [...tree].sort((a, b) => b - a) }
}

function callerPgid(facts: readonly ProcessFact[]): number | null {
  return facts.find((fact) => fact.pid === process.pid)?.pgid ?? null
}

function signal(
  first: OrphanProcess,
  plan: OrphanSignalPlan,
  value: NodeJS.Signals,
): { ok: true } | { ok: false; reason: string } {
  const targets = plan.kind === 'group' ? [-plan.pgid] : plan.pids
  for (const pid of targets) {
    const identity = verifyAndPlan(first)
    if (!identity.ok) return identity
    try {
      process.kill(pid, value)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
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
  return {
    ok: true,
    plan: orphanSignalPlan(
      verified!,
      inventory.facts,
      inventory.orphans,
      callerPgid(inventory.facts),
    ),
  }
}

export async function reclaimOrphanProcess(
  subject: string,
  dryRun: boolean,
): Promise<{ ok: boolean; action: string }> {
  const pid = Number(subject)
  if (!Number.isSafeInteger(pid) || pid <= 1)
    return { ok: false, action: `refused; invalid process id ${subject}` }
  const inventory = currentOrphanProcesses(projects().filter(isProjectRepository))
  if (inventory.error)
    return { ok: false, action: `refused; process inventory unavailable: ${inventory.error}` }
  const first = inventory.orphans.find((item) => item.pid === pid)
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
  const terminated = signal(first, initial.plan, 'SIGTERM')
  if (!terminated.ok) return { ok: false, action: `refused; ${terminated.reason}` }
  const deadline = Date.now() + RECLAIM_GRACE_MS
  while (pidAlive(pid) && Date.now() < deadline) await Bun.sleep(50)
  if (!pidAlive(pid))
    return {
      ok: true,
      action: `terminated orphan process tree rooted at pid ${pid} for missing tree ${first.missingTree}`,
    }
  const escalation = verifyAndPlan(first)
  if (!escalation.ok)
    return { ok: false, action: `refused SIGKILL escalation; ${escalation.reason}` }
  const killed = signal(first, escalation.plan, 'SIGKILL')
  if (!killed.ok) return { ok: false, action: `refused SIGKILL escalation; ${killed.reason}` }
  await Bun.sleep(50)
  return pidAlive(pid)
    ? { ok: false, action: `refused; pid ${pid} process tree did not exit after SIGKILL` }
    : {
        ok: true,
        action: `terminated orphan process tree rooted at pid ${pid} for missing tree ${first.missingTree}`,
      }
}

export function liveRunWorktrees(): Set<string> {
  return new Set(liveRuns().flatMap((row) => (row.worktree ? [row.worktree] : [])))
}
