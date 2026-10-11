// concern: monitor-release-live-conditions
/** Classifies release-rung live readings against successful ledger commits. */

import type { MonitorCondition } from './monitor-types.ts'

export type ReleaseLiveObservation = {
  project: string
  rung: string
  live: { commit: string } | { failure: string }
  lastReleasedCommit: string | null
}

/** Return report-only release differences and errors from unavailable observations. */
export function releaseLiveConditions(observations: readonly ReleaseLiveObservation[]): {
  conditions: MonitorCondition[]
  errors: string[]
} {
  const conditions: MonitorCondition[] = []
  const errors: string[] = []
  for (const observation of observations) {
    if ('failure' in observation.live) {
      errors.push(
        `${observation.project} release rung ${observation.rung} live reading failed: ${observation.live.failure}`,
      )
      continue
    }
    if (
      observation.lastReleasedCommit === null ||
      observation.live.commit === observation.lastReleasedCommit
    )
      continue
    conditions.push({
      kind: 'release-live-differs',
      subject: `${observation.project}:${observation.rung}`,
      since: null,
      ageMs: null,
      detail: `${observation.project} release rung ${observation.rung} live commit ${observation.live.commit} differs from last released commit ${observation.lastReleasedCommit}`,
      action: `report only; once the cause is understood, run orch release ${observation.project} --rung ${observation.rung}`,
      affectedProject: observation.project,
    })
  }
  return { conditions, errors }
}
