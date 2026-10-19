// concern: record-sync
/** Describes hosted evidence parents without depending on either record store. */
import type { RecordPayload as Payload } from './record-sync-contract.ts'

export type MachineEvidenceTable =
  | 'run'
  | 'question'
  | 'review'
  | 'review_lens'
  | 'review_finding'
  | 'review_read'
  | 'landing'
  | 'landing_override'
  | 'landing_review_carry'
  | 'landing_triage_snapshot'
  | 'contention'
  | 'test_flake'

export type EvidenceReference = {
  table: MachineEvidenceTable
  id: string
  kind: string
}

export function evidenceReferences(kind: string, row: Payload): EvidenceReference[] {
  const reference = (
    table: MachineEvidenceTable,
    id: unknown,
    label: string = table,
  ): EvidenceReference[] =>
    id == null || String(id) === '' ? [] : [{ table, id: String(id), kind: label }]
  switch (kind) {
    case 'run':
      return [
        ...reference('run', row.retryOf, 'retry run'),
        ...reference('run', row.parentRunId, 'parent run'),
      ]
    case 'score':
      return reference('run', row.id, 'scored run')
    case 'question':
      return reference('run', row.runId, 'question run')
    case 'review_lens':
      return [
        ...reference('review', row.reviewId, 'lens review'),
        ...reference('run', row.runId, 'lens run'),
      ]
    case 'review_finding':
      return [
        ...reference('review', row.reviewId, 'finding review'),
        ...reference('review_lens', row.reviewLensId, 'finding lens'),
      ]
    case 'landing':
      return reference('landing', row.causingLandingId, 'causing landing')
    case 'landing_review_carry':
      return reference('review', row.reviewId, 'carried review')
    case 'landing_triage_snapshot':
      return [
        ...(Array.isArray(row.reviewIds)
          ? row.reviewIds.flatMap((id) => reference('review', id, 'triage review'))
          : []),
        ...reference('review_read', row.readId, 'triage read'),
        ...reference('landing_override', row.overrideId, 'triage override'),
      ]
    case 'contention':
      return [
        ...reference('run', row.runId, 'contended run'),
        ...reference('landing', row.landingId, 'contended landing'),
      ]
    default:
      return []
  }
}
