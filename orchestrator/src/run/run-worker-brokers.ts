// concern: run-worker-brokers
/** Starts and stops worker-requested host execution brokers as one live-run resource. */

import { join } from 'node:path'
import {
  type FocusedTestBroker,
  startFocusedTestBroker,
} from '../focused-test/focused-test-broker.ts'
import { type GateBroker, startGateBroker } from '../gate/gate-broker.ts'
import type { BrokerConfinement as GateBrokerConfinement } from '../gate/gate-decision.ts'
import type { SandboxRuntimeConfig } from '../sandbox/sandbox.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { registerLiveGate } from './run-process.ts'
import { runTestWorkerEnvironment } from './run-test-workers.ts'

export type WorkerExecutionBrokers = { gate: GateBroker; focusedTests: FocusedTestBroker | null }
export type BrokerConfinement = GateBrokerConfinement<SandboxRuntimeConfig>

export function startWorkerExecutionBrokers(input: {
  repoJob: boolean
  writesRepo: boolean
  worktree: Worktree | null
  runId: string
  scratchDir: string
  environment: Record<string, string>
  confinement: BrokerConfinement
  onGateStart: (at: string) => void
  onGateFinish: (at: string) => void
}): WorkerExecutionBrokers | null {
  if (!input.repoJob || !input.worktree) return null
  const environment = {
    ...runTestWorkerEnvironment(input.environment),
    ...(input.confinement.kind === 'srt'
      ? {
          TMPDIR: input.scratchDir,
          TMP: input.scratchDir,
          TEMP: input.scratchDir,
          BUN_INSTALL_CACHE_DIR: join(input.scratchDir, 'bun-cache'),
        }
      : {}),
  }
  return {
    gate: startGateBroker({
      runId: input.runId,
      scratchDir: input.scratchDir,
      environment,
      confinement: input.confinement,
      registerActive: registerLiveGate,
      onExecutionStart: ({ at }) => input.onGateStart(at),
      onExecutionFinish: ({ at }) => input.onGateFinish(at),
    }),
    focusedTests: input.writesRepo
      ? startFocusedTestBroker({
          runId: input.runId,
          scratchDir: input.scratchDir,
          environment,
          confinement: input.confinement,
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
