// concern: workflows
/** Resolves a tracker task offered as mutable workflow floor evidence. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ArtifactEvidence } from './workflow-artifact-evidence.ts'
import type { ArtifactRef } from './workflow-artifact-reference.ts'
import { trackerTransitionTaskRemedy } from './workflow-floor.ts'
import { TIMED_FRESHNESS as FRESHNESS } from './workflow-floor-artifact-freshness.ts'
import {
  type FloorEvidencePorts,
  invokeFloorEvidencePort,
} from './workflow-floor-evidence-replay.ts'
import { resolveTaskCommentArtifact } from './workflow-floor-task-comment-evidence.ts'
import {
  artifactTaskIsNotCursorTask,
  type FloorTaskCursor,
  resolveTaskDocumentArtifact,
} from './workflow-floor-task-document-evidence.ts'

export async function resolveTaskArtifact(
  ref: Extract<ArtifactRef, { kind: 'task' | 'comment' | 'task-document' }>,
  raw: string,
  identity: FloorTaskCursor,
  ports: FloorEvidencePorts,
  hasTrackerTransitionFloor: boolean,
): Promise<ArtifactEvidence> {
  if (ref.kind === 'task-document')
    return await resolveTaskDocumentArtifact(ref, raw, identity, ports)
  if (!ports.readTask)
    throw new Error(
      `--artifact ${raw} needs a ${PLATFORM_SLUG} task read and no reader was provided`,
    )
  const task = invokeFloorEvidencePort(ports, 'readTask', ports.readTask, ref.key, { fresh: true })
  if (artifactTaskIsNotCursorTask(identity, { key: ref.key, recordId: task.recordId }))
    throw new Error(`--artifact ${raw} task is not this cursor's ${identity.workflowKey}`)
  if (ref.kind === 'task') {
    const notice = FRESHNESS.notice(
      FRESHNESS.task,
      task.updatedAt,
      identity.stepActivatedAt,
      hasTrackerTransitionFloor ? trackerTransitionTaskRemedy(ref.key) : undefined,
    )
    return { ref: raw, exists: task.key === ref.key, ...(notice ? { notice } : {}) }
  }
  return resolveTaskCommentArtifact(ref, raw, task, identity.stepActivatedAt)
}
