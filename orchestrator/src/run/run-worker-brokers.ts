// concern: run-worker-brokers
/** Starts and stops worker-requested host execution brokers as one live-run resource. */

import {
  type FocusedTestBroker,
  startFocusedTestBroker,
} from '../focused-test/focused-test-broker.ts'
import { type GateBroker, startGateBroker } from '../gate/gate-broker.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { registerLiveGate } from './run-process.ts'

export type WorkerExecutionBrokers = { gate: GateBroker; focusedTests: FocusedTestBroker | null }

export function startWorkerExecutionBrokers(input: {
  repoJob: boolean
  writesRepo: boolean
  worktree: Worktree | null
  runId: string
  scratchDir: string
  environment: Record<string, string>
  onGateStart: (at: string) => void
  onGateFinish: (at: string) => void
}): WorkerExecutionBrokers | null {
  if (!input.repoJob || !input.worktree) return null
  return {
    gate: startGateBroker({
      runId: input.runId,
      scratchDir: input.scratchDir,
      environment: input.environment,
      registerActive: registerLiveGate,
      onExecutionStart: ({ at }) => input.onGateStart(at),
      onExecutionFinish: ({ at }) => input.onGateFinish(at),
    }),
    focusedTests: input.writesRepo
      ? startFocusedTestBroker({
          runId: input.runId,
          scratchDir: input.scratchDir,
          environment: input.environment,
          registerActive: registerLiveGate,
        })
      : null,
  }
}

export async function closeWorkerExecutionBrokers(
  brokers: WorkerExecutionBrokers | null,
): Promise<void> {
  if (!brokers) return
  await brokers.gate.close()
  await brokers.focusedTests?.close()
}
