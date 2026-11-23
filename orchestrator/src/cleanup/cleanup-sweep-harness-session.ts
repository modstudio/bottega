// concern: harness session sweep measurement
/** Reaps stale publications and reports live Claude harnesses that published none. */

import { basename } from 'node:path'
import { readHarnessSession, reapHarnessSessions } from '../harness-session/harness-session.ts'
import { unpublishedHarnessProcesses } from '../harness-session/harness-session-decision.ts'
import { type ProcessFact, processTableSnapshot } from '../resources/process-inventory.ts'
import type { CleanupPresentation } from './cleanup.ts'

function isClaudeHarness(process: Pick<ProcessFact, 'command'>): boolean {
  const executable = process.command.trim().split(/\s+/, 1)[0] ?? ''
  return basename(executable) === 'claude'
}

export function sweepHarnessSessionPublications(
  dryRun: boolean,
  presentation: CleanupPresentation,
): boolean {
  reapHarnessSessions({ dryRun })
  const inventory = processTableSnapshot()
  if (inventory.error) {
    presentation.error(`harness process inventory failed: ${inventory.error}`)
    return true
  }
  const harnesses = inventory.facts
    .filter(isClaudeHarness)
    .map(({ pid, startTime }) => ({ pid, startTime }))
  const publications = harnesses.flatMap((process) => {
    const publication = readHarnessSession(process.pid)
    return publication ? [publication] : []
  })
  const unpublished = unpublishedHarnessProcesses(harnesses, publications)
  presentation.log(`harness processes without a published session: ${unpublished.length}`)
  for (const process of unpublished) presentation.log(`  ${process.pid} ${process.startTime}`)
  return false
}
