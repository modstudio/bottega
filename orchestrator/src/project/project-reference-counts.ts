import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type ProjectReferenceCounts = {
  run: number
  resource_claim: number
  canon_pack: number
  landing: number
  landing_override: number
  landing_review_carry: number
  landing_triage_snapshot: number
  review_read: number
  doc: number
  doc_revision: number
  review: number
  board_claim: number
  branch_landing_record: number
  presence: number
  worker_note_request: number
  workflow_cursor: number
  main_stack_activity: number
  port_pair_source: number
  port_pair_target: number
  port_ref: number
  port_ref_source: number
  port_ref_target: number
  project_lens_profile: number
  release_ledger: number
  subject: number
}

const REFERENCE_LABELS: { key: keyof ProjectReferenceCounts; label: string }[] = [
  { key: 'run', label: 'run' },
  { key: 'resource_claim', label: 'claim' },
  { key: 'canon_pack', label: 'canon_pack' },
  { key: 'landing', label: 'landing' },
  { key: 'landing_override', label: 'landing_override' },
  { key: 'landing_review_carry', label: 'landing_review_carry' },
  { key: 'landing_triage_snapshot', label: 'landing_triage_snapshot' },
  { key: 'review_read', label: 'review_read' },
  { key: 'doc', label: 'doc' },
  { key: 'doc_revision', label: 'doc_revision' },
  { key: 'review', label: 'review' },
  { key: 'board_claim', label: 'board_claim' },
  { key: 'branch_landing_record', label: 'branch_landing_record' },
  { key: 'presence', label: 'presence' },
  { key: 'worker_note_request', label: 'worker_note_request' },
  { key: 'workflow_cursor', label: 'workflow_cursor' },
  { key: 'main_stack_activity', label: 'main_stack_activity' },
  { key: 'port_pair_source', label: 'port_pair source' },
  { key: 'port_pair_target', label: 'port_pair target' },
  { key: 'port_ref', label: 'port_ref' },
  { key: 'port_ref_source', label: 'port_ref_source source' },
  { key: 'port_ref_target', label: 'port_ref_source target' },
  { key: 'project_lens_profile', label: 'project_lens_profile' },
  { key: 'release_ledger', label: 'release_ledger' },
  { key: 'subject', label: 'subject' },
]

/** Two anchored lines, or null when the row may be deleted. */
export function projectRemovalRefusal(
  name: string,
  counts: ProjectReferenceCounts,
): string[] | null {
  const named = REFERENCE_LABELS.filter(({ key }) => counts[key] > 0).map(
    ({ key, label }) => `${counts[key]} ${label}(s)`,
  )
  if (!named.length) return null
  return [
    `project ${name} is referenced by ${named.join(', ')}; removing it would blank their project attribution`,
    `cleared by: ${PLATFORM_SLUG} project retire ${name}`,
  ]
}

export function projectReferenceCounts(
  database: Database,
  projectRecordId: string,
): ProjectReferenceCounts {
  const count = (table: string, column = 'project_record_id') =>
    (
      database
        .query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`)
        .get(projectRecordId) as { n: number }
    ).n
  return {
    run: count('run'),
    resource_claim: count('resource_claim'),
    canon_pack: count('canon_pack'),
    landing: count('landing'),
    landing_override: count('landing_override'),
    landing_review_carry: count('landing_review_carry'),
    landing_triage_snapshot: count('landing_triage_snapshot'),
    review_read: count('review_read'),
    doc: count('doc'),
    doc_revision: count('doc_revision'),
    review: count('review'),
    board_claim: count('board_claim'),
    branch_landing_record: count('branch_landing_record'),
    presence: count('presence'),
    worker_note_request: count('worker_note_request'),
    workflow_cursor: count('workflow_cursor'),
    main_stack_activity: count('main_stack_activity'),
    port_pair_source: count('port_pair', 'source_project_record_id'),
    port_pair_target: count('port_pair', 'target_project_record_id'),
    port_ref: count('port_ref', 'target_project_record_id'),
    port_ref_source: count('port_ref_source', 'source_project_record_id'),
    port_ref_target: count('port_ref_source', 'target_project_record_id'),
    project_lens_profile: count('project_lens_profile'),
    release_ledger: count('release_ledger'),
    subject: count('subject'),
  }
}
