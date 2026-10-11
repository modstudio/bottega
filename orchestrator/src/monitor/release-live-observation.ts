// concern: monitor-release-live-observation
/** Gathers bounded release-rung readings and ledger baselines for one registered project. */

import type { Project } from '../project/projects.ts'
import { readLiveCommit } from '../release/live-reading.ts'
import { newestSuccessfulReleasedCommit } from '../release/release-service.ts'
import { type ReleaseLiveObservation, releaseLiveConditions } from './release-live-conditions.ts'

/** Observe every rung with a live command; one failed rung does not stop the rest. */
export function observeProjectReleaseLive(project: Project) {
  const observations: ReleaseLiveObservation[] = []
  const errors: string[] = []
  for (const rung of project.settings.release?.rungs ?? []) {
    if (!rung.live) continue
    try {
      const lastReleasedCommit = newestSuccessfulReleasedCommit(project.name, rung.name)
      const reading = readLiveCommit(rung.live, project.path)
      observations.push({
        project: project.name,
        rung: rung.name,
        live: reading.ok ? { commit: reading.commit } : { failure: reading.failure },
        lastReleasedCommit,
      })
    } catch (cause) {
      errors.push(
        `${project.name} release rung ${rung.name} live observation failed: ${String((cause as Error).message ?? cause)}`,
      )
    }
  }
  const decision = releaseLiveConditions(observations)
  return { conditions: decision.conditions, errors: [...errors, ...decision.errors] }
}
