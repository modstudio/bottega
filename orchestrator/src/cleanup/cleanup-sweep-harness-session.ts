// concern: harness session sweep measurement
/** Reaps stale publications and reports live Claude harnesses that published none. */

import { reapHarnessSessions } from '../harness-session/harness-session.ts'
import { unpublishedHarnessProcesses } from '../harness-session/harness-session-decision.ts'
import { processTableSnapshot } from '../resources/process-inventory.ts'
import type { CleanupPresentation } from './cleanup.ts'

type SweepHarnessSessionDependencies = {
  reap?: typeof reapHarnessSessions
  inventory?: typeof processTableSnapshot
}

export function sweepHarnessSessionPublications(
  dryRun: boolean,
  presentation: CleanupPresentation,
  dependencies: SweepHarnessSessionDependencies = {},
): boolean {
  try {
    const reaped = (dependencies.reap ?? reapHarnessSessions)({ dryRun })
    presentation.log(`harness session publications reaped: ${reaped.reaped}`)
    const inventory = (dependencies.inventory ?? processTableSnapshot)()
    if (inventory.error) {
      presentation.error(`harness process inventory failed: ${inventory.error}`)
      return true
    }
    const harnesses = inventory.facts.map(({ pid, startTime, command }) => ({
      pid,
      startTime,
      command,
    }))
    const unpublished = unpublishedHarnessProcesses(harnesses, reaped.publications)
    presentation.log(`harness processes without a published session: ${unpublished.length}`)
    for (const process of unpublished) presentation.log(`  ${process.pid} ${process.startTime}`)
    return false
  } catch (error) {
    presentation.error(
      `harness session publication sweep failed: ${error instanceof Error ? error.message : error}`,
    )
    return true
  }
}
