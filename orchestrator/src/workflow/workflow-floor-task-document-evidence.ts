// concern: workflows
/** Resolves a tracker task document offered as workflow floor evidence. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ArtifactRef } from './workflow-artifact-reference.ts'
import {
  type FloorEvidencePorts,
  invokeFloorEvidencePort,
  rethrowFloorEvidencePortMiss,
} from './workflow-floor-evidence-replay.ts'

type TaskDocumentCursor = {
  project: string
  workflowKey: string
  workflowTaskRecordId?: string | null
}

export async function resolveTaskDocumentArtifact(
  ref: Extract<ArtifactRef, { kind: 'task-document' }>,
  raw: string,
  identity: TaskDocumentCursor,
  ports: FloorEvidencePorts,
): Promise<{ ref: string; exists: boolean }> {
  if (ref.key !== identity.workflowKey)
    throw new Error(`--artifact ${raw} task is not this cursor's ${identity.workflowKey}`)
  if (!ports.readTaskDocument)
    throw new Error(
      `--artifact ${raw} needs a ${PLATFORM_SLUG} task document read and no reader was provided`,
    )
  try {
    await invokeFloorEvidencePort(
      ports,
      'readTaskDocument',
      ports.readTaskDocument,
      `${ref.key}/${ref.number}`,
      {
        project: identity.project,
        ...(identity.workflowTaskRecordId ? { recordId: identity.workflowTaskRecordId } : {}),
      },
    )
  } catch (error) {
    rethrowFloorEvidencePortMiss(error)
    if (!(error instanceof Error) || !error.message.startsWith('no task document ')) throw error
    throw new Error(
      `--artifact ${raw} does not exist for this cursor's task ${identity.workflowKey}`,
    )
  }
  return { ref: `${ref.key}/${ref.number}`, exists: true }
}
