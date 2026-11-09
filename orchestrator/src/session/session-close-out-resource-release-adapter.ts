// concern: session close-out resource release adapter
/** Delegates removed-tree reclamation to the cleanup subsystem's existing reclaimers. */

import {
  type RemovedTreeDockerCleanup,
  reclaimRemovedTreeDockerResources,
} from '../cleanup/cleanup-sweep-docker.ts'
import {
  type RemovedTreeProcessCleanup,
  reclaimRemovedTreeProcesses,
} from '../reclaim/orphan-process-reclaim.ts'
import {
  type SessionResourceReleaseReport,
  type SessionResourceReleaseTarget,
  sessionResourceReleaseReport,
} from './session-close-out-resource-release.ts'

export function reclaimSessionReleasedTree(
  target: SessionResourceReleaseTarget,
): SessionResourceReleaseReport {
  const processes: RemovedTreeProcessCleanup = { reclaimed: [], kept: [], errors: [] }
  try {
    Object.assign(processes, reclaimRemovedTreeProcesses([target.path]))
  } catch (cause) {
    processes.errors.push(cause instanceof Error ? cause.message : String(cause))
  }
  const compose: RemovedTreeDockerCleanup = { removed: [], kept: [], errors: [] }
  try {
    Object.assign(
      compose,
      reclaimRemovedTreeDockerResources([
        { path: target.path, removedRunIds: new Set(target.runRecordIds) },
      ]),
    )
  } catch (cause) {
    compose.errors.push(cause instanceof Error ? cause.message : String(cause))
  }
  return sessionResourceReleaseReport(target, processes, {
    reclaimed: compose.removed,
    kept: compose.kept.map(({ item, reason, composeProject }) => ({
      item,
      reason,
      composeProject,
    })),
    errors: compose.errors,
  })
}
