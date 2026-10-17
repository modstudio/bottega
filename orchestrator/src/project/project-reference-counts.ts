import type { Database } from 'bun:sqlite'

export const PROJECT_REFERENCES = [
  ['run', 'run', 'project_record_id'],
  ['resource_claim', 'claim', 'project_record_id'],
  ['canon_pack', 'canon_pack', 'project_record_id'],
  ['landing', 'landing', 'project_record_id'],
  ['landing_override', 'landing_override', 'project_record_id'],
  ['landing_review_carry', 'landing_review_carry', 'project_record_id'],
  ['landing_triage_snapshot', 'landing_triage_snapshot', 'project_record_id'],
  ['review_read', 'review_read', 'project_record_id'],
  ['doc', 'doc', 'project_record_id'],
  ['doc_revision', 'doc_revision', 'project_record_id'],
  ['review', 'review', 'project_record_id'],
  ['board_claim', 'board_claim', 'project_record_id'],
  ['board_message', 'board_message', 'author_project_record_id'],
  ['branch_landing_record', 'branch_landing_record', 'project_record_id'],
  ['presence', 'presence', 'project_record_id'],
  ['worker_note_request', 'worker_note_request', 'project_record_id'],
  ['workflow_cursor', 'workflow_cursor', 'project_record_id'],
  ['main_stack_activity', 'main_stack_activity', 'project_record_id'],
  ['port_pair_source', 'port_pair source', 'source_project_record_id', 'port_pair'],
  ['port_pair_target', 'port_pair target', 'target_project_record_id', 'port_pair'],
  ['port_ref', 'port_ref', 'target_project_record_id'],
  ['port_ref_source', 'port_ref_source source', 'source_project_record_id', 'port_ref_source'],
  ['port_ref_target', 'port_ref_source target', 'target_project_record_id', 'port_ref_source'],
  ['project_lens_profile', 'project_lens_profile', 'project_record_id'],
  ['release_ledger', 'release_ledger', 'project_record_id'],
  ['subject', 'subject', 'project_record_id'],
] as const

export type ProjectReferenceKey = (typeof PROJECT_REFERENCES)[number][0]
export type ProjectReferenceCounts = Record<ProjectReferenceKey, number>

export function projectReferenceCounts(
  database: Database,
  projectRecordId: string,
): ProjectReferenceCounts {
  return Object.fromEntries(
    PROJECT_REFERENCES.map(([key, , column, explicitTable]) => {
      const table = explicitTable ?? key
      const row = database
        .query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?`)
        .get(projectRecordId) as { n: number }
      return [key, row.n]
    }),
  ) as ProjectReferenceCounts
}
