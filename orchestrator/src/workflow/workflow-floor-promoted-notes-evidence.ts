// concern: workflow-floor-promoted-notes-evidence
/** Gathers the promoted-note set without deciding whether the floor is met. */

import type { ValidatedEvidence } from './workflow-floor.ts'
import {
  type FloorEvidencePorts,
  invokeFloorEvidencePort,
  rethrowFloorEvidencePortMiss,
} from './workflow-floor-evidence-replay.ts'

export async function gatherPromotedNotes(
  project: string,
  taskKey: string,
  ports: FloorEvidencePorts,
): Promise<NonNullable<ValidatedEvidence['promotedNotes']>> {
  try {
    const notes = await invokeFloorEvidencePort(
      ports,
      'listPromotedNotes',
      async () => {
        throw new Error('floor evidence port listPromotedNotes has no implementation')
      },
      project,
      taskKey,
    )
    return { known: true, notes }
  } catch (error) {
    rethrowFloorEvidencePortMiss(error)
    const detail = error instanceof Error ? error.message : String(error)
    return {
      known: false,
      reason: detail.split(/\r?\n/, 1)[0]?.trim() || 'promoted note read failed',
    }
  }
}
