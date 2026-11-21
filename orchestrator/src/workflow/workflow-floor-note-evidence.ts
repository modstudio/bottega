// concern: workflow-floor-note-evidence
/** Resolves note artifacts through the injected hub-note reader. */

import type { ValidatedArtifactEvidence } from './workflow-artifact-evidence.ts'
import type { ArtifactRef } from './workflow-artifact-reference.ts'
import { requireMutableArtifactFreshness } from './workflow-floor-artifact-freshness.ts'
import {
  type FloorEvidencePorts,
  invokeFloorEvidencePort,
} from './workflow-floor-evidence-replay.ts'

export async function gatherNoteArtifactEvidence(
  parsed: Extract<ArtifactRef, { kind: 'note' }>,
  offeredArtifact: string,
  project: string,
  stepActivatedAt: string,
  ports: FloorEvidencePorts,
): Promise<{
  artifact: ValidatedArtifactEvidence['artifact']
  note: NonNullable<ValidatedArtifactEvidence['note']>
}> {
  if (!ports.readNote)
    throw new Error(`--artifact ${offeredArtifact} needs note evidence and no reader was provided`)
  const note = await invokeFloorEvidencePort(
    ports,
    'readNote',
    ports.readNote,
    project,
    parsed.reference,
  )
  const evidence = {
    reference: parsed.reference,
    recordId: note?.recordId ?? null,
    label: note?.label ?? null,
    promotedTask: note?.promotedTask ?? null,
    staleAt: note?.staleAt ?? null,
    writtenAt: note?.writtenAt,
  }
  if (evidence.recordId)
    requireMutableArtifactFreshness('note', evidence.writtenAt, stepActivatedAt)
  return {
    artifact: { ref: offeredArtifact, exists: evidence.recordId !== null },
    note: evidence,
  }
}
