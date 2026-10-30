// concern: fresh repository run host admission
/** Waits after the run row exists and before claim starts any tree lifecycle. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { recordRunWarning } from '../events.ts'
import { waitForRunHostCapacity } from './run-host-capacity.ts'

export async function admitFreshRepositoryRun(input: {
  database: Database
  runId: string
  repoJob: boolean
  existingChain: boolean
}): Promise<void> {
  if (!input.repoJob || input.existingChain) return
  const result = await waitForRunHostCapacity({ database: input.database, runId: input.runId })
  if (result?.drainingFor) {
    throw new Error(
      `run stopped for migration drain ${result.drainingFor}; re-dispatch after ${PLATFORM_SLUG} machine update finishes`,
    )
  }
  if (result?.boundReached) {
    const message = `host capacity wait bound reached after ${result.waitedMs}ms; starting run`
    console.error(`orch: ${message}`)
    recordRunWarning(input.runId, message)
  }
  if (result?.outcome === 'stopped') throw new Error('run stopped while waiting for host capacity')
}
