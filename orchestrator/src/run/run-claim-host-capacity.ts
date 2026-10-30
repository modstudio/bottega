// concern: fresh repository run host admission
/** Waits after the run row exists and before claim starts any tree lifecycle. */

import type { Database } from 'bun:sqlite'
import { raiseForHostCapacityWait, waitForRunHostCapacity } from './run-host-capacity.ts'

export type HostCapacityWaitDeps = Pick<
  Parameters<typeof waitForRunHostCapacity>[0],
  'env' | 'platform' | 'now' | 'sleep' | 'random' | 'measure'
>

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
