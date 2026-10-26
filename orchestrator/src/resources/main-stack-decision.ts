// concern: disposable Docker resource and main-stack policy

import type { MainStackConsumer } from '../project/project-settings.ts'

export function decideTerminalDockerInventory(facts: {
  inventorySupplied: boolean
  chainHasRecordedWorktree: boolean
}): 'use-supplied' | 'take' | 'skip' {
  if (facts.inventorySupplied) return 'use-supplied'
  return facts.chainHasRecordedWorktree ? 'take' : 'skip'
}

export type WorktreeResourceFacts = {
  attributable: boolean
  mainCheckout: boolean
  liveRun: boolean
  terminalRun: boolean
  treeAbsent: boolean
}

export function decideWorktreeResourceTeardown(
  facts: WorktreeResourceFacts,
): 'remove' | 'keep' | 'report' {
  if (!facts.attributable) return 'report'
  if (facts.mainCheckout) return 'keep'
  if (facts.liveRun) return 'keep'
  return facts.terminalRun || facts.treeAbsent ? 'remove' : 'keep'
}

export type MainStackIdleFacts = {
  recordsAvailable: boolean
  running: boolean
  servedWorktree: boolean | 'unknown'
  execInProgress: boolean | 'unknown'
  liveRun: boolean
  liveSession: boolean
  lastWorktreeCreatedAtMs: number | null
  lastGateAtMs: number | null
  lastEnsureAtMs: number | null
  nowMs: number
  idleStopAfterMs: number
}

export type MainStackStopGuardFacts = Pick<
  MainStackIdleFacts,
  'servedWorktree' | 'execInProgress' | 'liveRun' | 'liveSession'
>

export function decideMainStackStopGuard(
  facts: MainStackStopGuardFacts,
): 'stop' | 'keep' | 'report' {
  if (facts.servedWorktree === true) return 'keep'
  if (facts.servedWorktree === 'unknown') return 'report'
  if (facts.execInProgress === true) return 'keep'
  if (facts.execInProgress === 'unknown') return 'report'
  if (facts.liveRun || facts.liveSession) return 'keep'
  return 'stop'
}

/** Name the fact that kept the stack, in the order the guard consulted it. */
export function mainStackStopGuardReason(input: {
  facts: MainStackStopGuardFacts
  execInProgressReason?: string | undefined
  servedWorktreeReason?: string | undefined
}): string {
  const because = (reason: string | undefined) => (reason ? `: ${reason}` : '')
  if (input.facts.servedWorktree === true) return 'a worktree of this project is served'
  if (input.facts.servedWorktree === 'unknown')
    return `Docker could not show whether a worktree is served${because(input.servedWorktreeReason)}`
  if (input.facts.execInProgress === true) return 'a Docker exec is in progress'
  if (input.facts.execInProgress === 'unknown')
    return `Docker command activity could not be ascertained${because(input.execInProgressReason)}`
  if (input.facts.liveRun) return 'a run is running or asking'
  return 'an architect session is live'
}

/** One running container's Compose identity, as the Docker inventory reports it. */
export type ServedWorktreeEntry = {
  composeProject: string
  /** The container's `com.docker.compose.project.working_dir`, in canonical spelling. */
  workingDirectory: string
}

/** What Docker shows about this project's served worktrees, plus what it could not count. */
export type ServedWorktreeObservation = {
  value: boolean | 'unknown'
  reason?: string | undefined
  /**
   * Compose projects of containers whose working directory names a worktree that is no
   * longer there. Kept out of `value`: a container left behind is a durable claim, not a
   * live use, and it must be reported rather than pin the shared stack invisibly.
   */
  orphans: readonly string[]
}

/**
 * Whether a served worktree of the project is running.
 *
 * A working directory inside the project's own worktrees directory counts only while that
 * directory still exists; once it is gone the container is an orphan and is reported
 * instead. A declared Compose prefix has no directory to check, so it counts as served.
 */
export function classifyServedWorktree(facts: {
  entries: readonly ServedWorktreeEntry[]
  /** Canonical `<registered checkout>/.claude/worktrees` of this project. */
  worktreesDirectory: string
  /** The project's declared served-worktree Compose prefix, anchored on a separator. */
  composePrefix?: string | undefined
  /** Whether the worktree directory a working directory names still exists. */
  treeExists: (worktreeDirectory: string) => boolean
}): ServedWorktreeObservation {
  const orphans: string[] = []
  for (const entry of facts.entries) {
    if (facts.composePrefix !== undefined && entry.composeProject.startsWith(facts.composePrefix)) {
      return { value: true, orphans }
    }
    if (!entry.workingDirectory.startsWith(`${facts.worktreesDirectory}/`)) continue
    if (facts.treeExists(entry.workingDirectory)) return { value: true, orphans }
    orphans.push(entry.composeProject)
  }
  return { value: false, orphans }
}

export function decideMainStackIdleStop(facts: MainStackIdleFacts): 'stop' | 'keep' | 'report' {
  if (!facts.recordsAvailable) return 'report'
  if (!facts.running) return 'keep'
  const guard = decideMainStackStopGuard(facts)
  if (guard !== 'stop') return guard
  const cutoff = facts.nowMs - facts.idleStopAfterMs
  if (facts.lastWorktreeCreatedAtMs !== null && facts.lastWorktreeCreatedAtMs > cutoff)
    return 'keep'
  if (facts.lastGateAtMs !== null && facts.lastGateAtMs > cutoff) return 'keep'
  if (facts.lastEnsureAtMs !== null && facts.lastEnsureAtMs > cutoff) return 'keep'
  return 'stop'
}

export function decideMainStackEnsure(input: {
  consumer: MainStackConsumer
  declaration: { consumers: MainStackConsumer[]; requiredServices?: string[] } | undefined
  observed: { runningServices: string[] } | 'unknown'
}): 'skip' | 'start-services' | 'start-stack' | 'refuse' {
  if (!input.declaration?.consumers.includes(input.consumer)) return 'skip'
  if (input.observed === 'unknown') return 'refuse'
  const required = input.declaration.requiredServices
  if (required) {
    const running = new Set(input.observed.runningServices)
    return required.every((service) => running.has(service)) ? 'skip' : 'start-services'
  }
  return input.observed.runningServices.length === 0 ? 'start-stack' : 'skip'
}

/** Name only services newly started for one consumer so its release cannot stop prior users. */
export function newlyStartedMainStackServices(input: {
  decision: ReturnType<typeof decideMainStackEnsure>
  before: readonly string[]
  requiredServices?: readonly string[]
  after?: readonly string[]
}): string[] {
  if (input.decision === 'skip' || input.decision === 'refuse') return []
  const before = new Set(input.before)
  const candidates =
    input.decision === 'start-services' ? (input.requiredServices ?? []) : (input.after ?? [])
  return candidates.filter((service) => !before.has(service))
}
