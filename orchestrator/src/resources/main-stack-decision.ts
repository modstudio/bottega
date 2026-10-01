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
  lastWorktreeCreatedAtMs: number | null
  lastGateAtMs: number | null
  nowMs: number
  idleStopAfterMs: number
}

export function decideMainStackIdleStop(facts: MainStackIdleFacts): 'stop' | 'keep' | 'report' {
  if (!facts.recordsAvailable) return 'report'
  if (!facts.running || facts.liveRun) return 'keep'
  const cutoff = facts.nowMs - facts.idleStopAfterMs
  if (facts.lastWorktreeCreatedAtMs !== null && facts.lastWorktreeCreatedAtMs > cutoff)
    return 'keep'
  if (facts.lastGateAtMs !== null && facts.lastGateAtMs > cutoff) return 'keep'
  return 'stop'
}

export function decideMainStackStart(input: {
  consumer: MainStackConsumer
  declaredConsumers: MainStackConsumer[]
  stackState: 'running' | 'stopped' | 'unknown'
}): 'start' | 'continue' | 'report' {
  if (!input.declaredConsumers.includes(input.consumer)) return 'continue'
  if (input.stackState === 'unknown') return 'report'
  return input.stackState === 'stopped' ? 'start' : 'continue'
}
