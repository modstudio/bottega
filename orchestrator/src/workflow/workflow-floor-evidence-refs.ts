// concern: workflows
/** Serializes validated floor evidence into the durable cursor trail vocabulary. */

import { CLASS_MEASUREMENT_EVIDENCE } from './workflow-class-measurement-trail.ts'

export type EvidenceRef = { flag: string; value: string }

type RefEvidence = {
  ruling?: { id: number }
  review?: { number: number }
  gate?: { recordId: string }
  run?: { id: string }
  artifacts?: Array<{ artifact: { ref: string } }>
  task?: { key: string }
  classMeasurement?: { className: string; command: string; execId: number; count: number }
}

export function evidenceRefs(evidence: RefEvidence): EvidenceRef[] {
  const refs: EvidenceRef[] = []
  if (evidence.ruling) refs.push({ flag: '--ruling', value: String(evidence.ruling.id) })
  if (evidence.review) refs.push({ flag: '--review', value: String(evidence.review.number) })
  if (evidence.gate) refs.push({ flag: '--gate', value: evidence.gate.recordId })
  if (evidence.run) refs.push({ flag: '--run', value: String(evidence.run.id) })
  const artifactRefs = new Set<string>()
  for (const entry of evidence.artifacts ?? []) {
    if (artifactRefs.has(entry.artifact.ref)) continue
    artifactRefs.add(entry.artifact.ref)
    refs.push({ flag: '--artifact', value: entry.artifact.ref })
  }
  if (evidence.task) refs.push({ flag: '--task', value: evidence.task.key })
  if (evidence.classMeasurement) {
    refs.push({
      flag: CLASS_MEASUREMENT_EVIDENCE.className,
      value: evidence.classMeasurement.className,
    })
    refs.push({
      flag: CLASS_MEASUREMENT_EVIDENCE.command,
      value: evidence.classMeasurement.command,
    })
    refs.push({
      flag: CLASS_MEASUREMENT_EVIDENCE.execId,
      value: String(evidence.classMeasurement.execId),
    })
    refs.push({
      flag: CLASS_MEASUREMENT_EVIDENCE.count,
      value: String(evidence.classMeasurement.count),
    })
  }
  return refs
}
