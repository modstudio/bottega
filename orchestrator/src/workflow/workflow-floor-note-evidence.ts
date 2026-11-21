// concern: workflow-floor-note-evidence
/** Resolves note artifacts through the injected hub-note reader. */

import type { ValidatedArtifactEvidence } from './workflow-artifact-evidence.ts'
import type { ArtifactRef } from './workflow-floor.ts'
import {
  type FloorEvidencePorts,
  invokeFloorEvidencePort,
} from './workflow-floor-evidence-replay.ts'

export async function gatherNoteArtifactEvidence(
  parsed: Extract<ArtifactRef, { kind: 'note' }>,
  offeredArtifact: string,
  project: string,
  ports: FloorEvidencePorts,
): Promise<Pick<ValidatedArtifactEvidence, 'artifact' | 'note'>> {
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
  }
  return {
    artifact: { ref: offeredArtifact, exists: evidence.recordId !== null },
    note: evidence,
  }
}
