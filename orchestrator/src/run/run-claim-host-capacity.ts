// concern: repository run host admission and wait-outcome ruling
/** Waits before tree lifecycle and applies the shared ruling to a wait's outcome. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { recordRunWarning } from '../events.ts'
import { type RunHostCapacityWait, waitForRunHostCapacity } from './run-host-capacity.ts'

export type HostCapacityWaitDeps = Pick<
  Parameters<typeof waitForRunHostCapacity>[0],
  'env' | 'platform' | 'now' | 'sleep' | 'random' | 'measure'
>

/** Apply the shared operator-facing policy for a completed host-capacity wait. */
export function raiseForHostCapacityWait(
  wait: RunHostCapacityWait | null,
  runId: string,
  stopped: boolean,
): void {
  if (wait?.drainingFor) {
    throw new Error(
      `run stopped for migration drain ${wait.drainingFor}; re-dispatch after ${PLATFORM_SLUG} machine update finishes`,
    )
  }
  if (wait?.boundReached) {
    const message = `host capacity wait bound reached after ${wait.waitedMs}ms; starting run`
    console.error(`orch: ${message}`)
    recordRunWarning(runId, message)
  }
  if (stopped) throw new Error('run stopped while waiting for host capacity')
}

export async function admitFreshRepositoryRun(
  database: Database,
  runId: string,
  repoJob: boolean,
  existingChain: boolean,
  deps: HostCapacityWaitDeps = {},
): Promise<void> {
  if (!repoJob || existingChain) return
  const result = await waitForRunHostCapacity({ database, runId, ...deps })
  raiseForHostCapacityWait(result, runId, result?.outcome === 'stopped')
}
