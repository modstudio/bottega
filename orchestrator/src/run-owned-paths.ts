// concern: pure run-owned path layout; confinement and probes import it directly, all other consumers use run-artifacts

import { join } from 'node:path'

export function runScratchDir(id: string, runsDir: string): string {
  return join(runsDir, String(id), 'scratch')
}
export const runHarnessStateDir = (runtimeDir: string): string => join(runtimeDir, 'harness')
export const runWorkerHomeDir = (runtimeDir: string): string => join(runtimeDir, 'home')
export const runCheckpointHooksDir = (runtimeDir: string): string =>
  join(runtimeDir, 'checkpoint-hooks')

/** The complete on-disk layout owned by one run chain. */
export function runOwnedPaths(runId: string, sandboxRootId: string, runsDir: string) {
  const runtimeDir = join(runsDir, `sandbox-${sandboxRootId}`)
  return {
    scratchDir: runScratchDir(runId, runsDir),
    runtimeDir,
    harnessStateDir: runHarnessStateDir(runtimeDir),
    workerHomeDir: runWorkerHomeDir(runtimeDir),
    checkpointHooksDir: runCheckpointHooksDir(runtimeDir),
  }
}
