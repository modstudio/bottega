// concern: disposable Docker resource and main-stack policy

import type { MainStackConsumer } from '../project/project-settings.ts'

export function decideTerminalDockerInventory(facts: {
  inventorySupplied: boolean
  chainHasRecordedWorktree: boolean
}): 'use-supplied' | 'take' | 'skip' {
  if (facts.inventorySupplied) return 'use-supplied'
  return facts.chainHasRecordedWorktree ? 'take' : 'skip'
}

export function classifyMainStackState(facts: {
  containerCount: number
  runningContainerCount: number
}): 'running' | 'stopped' {
  return facts.runningContainerCount > 0 ? 'running' : 'stopped'
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
  liveRun: boolean
  liveSession: boolean
  lastWorktreeCreatedAtMs: number | null
  lastGateAtMs: number | null
  lastEnsureAtMs: number | null
  nowMs: number
  idleStopAfterMs: number
}

export function decideMainStackIdleStop(facts: MainStackIdleFacts): 'stop' | 'keep' | 'report' {
  if (!facts.recordsAvailable) return 'report'
  if (!facts.running || facts.liveRun || facts.liveSession) return 'keep'
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
