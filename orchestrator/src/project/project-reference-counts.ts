import type { Database } from 'bun:sqlite'
import type { ProjectReferenceCounts } from './projects.ts'

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
