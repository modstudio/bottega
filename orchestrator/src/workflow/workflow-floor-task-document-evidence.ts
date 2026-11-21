// concern: workflows
/** Resolves a tracker task document offered as workflow floor evidence. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { ArtifactRef } from './workflow-artifact-reference.ts'
import {
  type FloorEvidencePorts,
  invokeFloorEvidencePort,
} from './workflow-floor-evidence-replay.ts'

type TaskDocumentCursor = {
  project: string
  workflowKey: string
  workflowTaskRecordId?: string | null
}

export function artifactTaskIsNotCursorTask(
  identity: TaskDocumentCursor,
  task: { key: string; recordId?: string | null },
): boolean {
  return identity.workflowTaskRecordId
    ? task.recordId !== identity.workflowTaskRecordId
    : Boolean(identity.workflowKey) && task.key !== identity.workflowKey
}

export async function resolveTaskDocumentArtifact(
  ref: Extract<ArtifactRef, { kind: 'task-document' }>,
  raw: string,
  identity: TaskDocumentCursor,
  ports: FloorEvidencePorts,
): Promise<{ ref: string; exists: boolean }> {
  if (!identity.workflowTaskRecordId && artifactTaskIsNotCursorTask(identity, { key: ref.key }))
    throw new Error(`--artifact ${raw} task is not this cursor's ${identity.workflowKey}`)
  if (!ports.readTaskDocument)
    throw new Error(
      `--artifact ${raw} needs a ${PLATFORM_SLUG} task document read and no reader was provided`,
    )
  const document = await invokeFloorEvidencePort(
    ports,
    'readTaskDocument',
    ports.readTaskDocument,
    `${ref.key}/${ref.number}`,
    {
      project: identity.project,
      ...(identity.workflowTaskRecordId ? { recordId: identity.workflowTaskRecordId } : {}),
    },
  )
  if (!document)
    throw new Error(
      `--artifact ${raw} does not exist for this cursor's task ${identity.workflowKey}`,
    )
  if (
    artifactTaskIsNotCursorTask(identity, {
      key: ref.key,
      recordId: document.task_record_id,
    })
  )
    throw new Error(`--artifact ${raw} task is not this cursor's ${identity.workflowKey}`)
  return { ref: `${ref.key}/${ref.number}`, exists: true }
}
