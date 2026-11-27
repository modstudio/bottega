// concern: run-worker-brokers
/** Starts and stops worker-requested host execution brokers as one live-run resource. */

import { join } from 'node:path'
import {
  type FocusedTestBroker,
  startFocusedTestBroker,
} from '../focused-test/focused-test-broker.ts'
import { type GateBroker, startGateBroker } from '../gate/gate-broker.ts'
import type { BrokerConfinement as GateBrokerConfinement } from '../gate/gate-decision.ts'
import { writingRunTempDir } from '../run-owned-paths.ts'
import type { SandboxRuntimeConfig } from '../sandbox/sandbox.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import { registerLiveGate } from './run-process.ts'
import { prepareRunTemp } from './run-temp.ts'
import { runTestWorkerEnvironment } from './run-test-workers.ts'

export type WorkerExecutionBrokers = { gate: GateBroker; focusedTests: FocusedTestBroker | null }
export type BrokerConfinement = GateBrokerConfinement<SandboxRuntimeConfig>

export function workerBrokerConfinement(
  input: { writingAcp: boolean; scratchDir: string },
  profile: SandboxRuntimeConfig | null,
): BrokerConfinement {
  const temporaryDirectory = writingRunTempDir(input.scratchDir)
  prepareRunTemp(temporaryDirectory)
  if (!input.writingAcp) return { kind: 'host', temporaryDirectory }
  if (!profile) throw new Error('writing ACP broker confinement requires an srt profile')
  return { kind: 'srt', profile, temporaryDirectory }
}

export function startWorkerExecutionBrokers(input: {
  repoJob: boolean
  writesRepo: boolean
  worktree: Worktree | null
  runId: string
  scratchDir: string
  environment: Record<string, string>
  confinement: BrokerConfinement
  onExecutionStart: () => void
  onExecutionFinish: () => void
  onGateStart: (at: string) => void
  onGateFinish: (at: string) => void
}): WorkerExecutionBrokers | null {
  if (!input.repoJob || !input.worktree) return null
  const environment = {
    ...runTestWorkerEnvironment(input.environment),
    ...(input.confinement.kind === 'srt'
      ? {
          TMPDIR: input.confinement.temporaryDirectory,
          TMP: input.confinement.temporaryDirectory,
          TEMP: input.confinement.temporaryDirectory,
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
      onExecutionStart: ({ at }) => {
        input.onExecutionStart()
        try {
          input.onGateStart(at)
        } catch (error) {
          input.onExecutionFinish()
          throw error
        }
      },
      onExecutionFinish: ({ at }) => {
        try {
          input.onGateFinish(at)
        } finally {
          input.onExecutionFinish()
        }
      },
    }),
    focusedTests: input.writesRepo
      ? startFocusedTestBroker({
          runId: input.runId,
          scratchDir: input.scratchDir,
          environment,
          confinement: input.confinement,
          registerActive: registerLiveGate,
          onExecutionStart: input.onExecutionStart,
          onExecutionFinish: input.onExecutionFinish,
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
