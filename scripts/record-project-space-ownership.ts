export type ProjectSpaceOwnership =
  | { table: string; kind: 'project'; ownerColumns: readonly string[] }
  | {
      table: string
      kind: 'parent'
      parents: readonly { table: string; column: string }[]
    }
  | { table: string; kind: 'space'; reason: string }

/**
 * Exhaustive classification of hosted tables carrying space_id.
 *
 * Project rows are moved through one of the named owner columns, parent rows
 * follow a declared project-owned parent, and space rows deliberately remain
 * in their space. The migration replay gate compares this declaration with the
 * live migrated catalogue and with record_move_project_space's declaration.
 */
export const RECORD_PROJECT_SPACE_OWNERSHIP = [
  { table: 'branch_disposal', kind: 'project', ownerColumns: ['project_id'] },
  { table: 'config_entry', kind: 'space', reason: 'space configuration' },
  {
    table: 'config_secret',
    kind: 'space',
    reason: 'space configuration secret',
  },
  {
    table: 'contention',
    kind: 'parent',
    parents: [
      { table: 'run', column: 'run_id' },
      { table: 'landing', column: 'landing_id' },
    ],
  },
  { table: 'doc', kind: 'project', ownerColumns: ['project_id'] },
  {
    table: 'doc_related_subject',
    kind: 'parent',
    parents: [{ table: 'doc', column: 'doc_id' }],
  },
  { table: 'doc_revision', kind: 'project', ownerColumns: ['project_id'] },
  {
    table: 'hub_change',
    kind: 'space',
    reason: 'space synchronization journal',
  },
  {
    table: 'hub_change_head',
    kind: 'space',
    reason: 'space synchronization cursor',
  },
  { table: 'hub_day', kind: 'space', reason: 'space-and-day aggregate' },
  {
    table: 'hub_interval',
    kind: 'project',
    ownerColumns: ['project_id', 'project_name', 'task_key'],
  },
  {
    table: 'hub_note',
    kind: 'project',
    ownerColumns: ['project_id', 'project_name'],
  },
  {
    table: 'hub_note_acknowledgement',
    kind: 'project',
    ownerColumns: ['project_id', 'project_name'],
  },
  {
    table: 'hub_report_subscription',
    kind: 'project',
    ownerColumns: ['project_id', 'project_name'],
  },
  {
    table: 'hub_report_subscription_member',
    kind: 'parent',
    parents: [{ table: 'hub_report_subscription', column: 'subscription_id' }],
  },
  {
    table: 'hub_report_subscription_project',
    kind: 'space',
    reason: 'space report selector; project_space_id is re-pointed without moving the selector',
  },
  {
    table: 'hub_report_subscription_recipient',
    kind: 'parent',
    parents: [{ table: 'hub_report_subscription', column: 'subscription_id' }],
  },
  {
    table: 'hub_send',
    kind: 'space',
    reason: 'delivery may summarize several projects',
  },
  {
    table: 'hub_send_recipient',
    kind: 'space',
    reason: 'recipient follows a space delivery',
  },
  {
    table: 'hub_task',
    kind: 'project',
    ownerColumns: ['project_id', 'project_name'],
  },
  {
    table: 'hub_task_comment',
    kind: 'project',
    ownerColumns: ['project_id', 'project_name'],
  },
  {
    table: 'hub_task_document',
    kind: 'project',
    ownerColumns: ['project_id', 'project_name'],
  },
  {
    table: 'hub_task_status_event',
    kind: 'project',
    ownerColumns: ['project_id', 'project_name'],
  },
  { table: 'invitation', kind: 'space', reason: 'space membership invitation' },
  { table: 'landing', kind: 'project', ownerColumns: ['project_id'] },
  { table: 'landing_override', kind: 'project', ownerColumns: ['project_id'] },
  {
    table: 'landing_review_carry',
    kind: 'project',
    ownerColumns: ['project_id'],
  },
  {
    table: 'landing_triage_snapshot',
    kind: 'project',
    ownerColumns: ['project_id'],
  },
  { table: 'pull_request_ci', kind: 'project', ownerColumns: ['project_id'] },
  { table: 'lens', kind: 'space', reason: 'space lens catalogue' },
  {
    table: 'lens_profile',
    kind: 'space',
    reason: 'space lens profile catalogue',
  },
  {
    table: 'lens_profile_revision',
    kind: 'space',
    reason: 'space lens profile history',
  },
  { table: 'lens_revision', kind: 'space', reason: 'space lens history' },
  {
    table: 'machine_public_key',
    kind: 'space',
    reason: 'space machine authorization',
  },
  { table: 'machine_name_claim', kind: 'space', reason: 'space machine name reservation' },
  { table: 'membership', kind: 'space', reason: 'space membership' },
  {
    table: 'operator_waiting_email',
    kind: 'space',
    reason:
      'user delivery episode; project and task key are display metadata, not stable ownership',
  },
  { table: 'orch_snapshot', kind: 'space', reason: 'space snapshot' },
  {
    table: 'port_baseline',
    kind: 'parent',
    parents: [{ table: 'port_pair', column: 'pair_id' }],
  },
  { table: 'port_doctrine', kind: 'space', reason: 'space porting doctrine' },
  { table: 'port_pair', kind: 'project', ownerColumns: ['target_project_id'] },
  { table: 'port_ref', kind: 'project', ownerColumns: ['target_project_id'] },
  {
    table: 'port_ref_source',
    kind: 'parent',
    parents: [{ table: 'port_ref', column: 'ref_id' }],
  },
  {
    table: 'port_skip',
    kind: 'parent',
    parents: [{ table: 'port_pair', column: 'pair_id' }],
  },
  { table: 'project', kind: 'project', ownerColumns: ['id'] },
  {
    table: 'project_lens_profile',
    kind: 'project',
    ownerColumns: ['project_id'],
  },
  {
    table: 'project_lens_profile_revision',
    kind: 'parent',
    parents: [{ table: 'project_lens_profile', column: 'selection_id' }],
  },
  { table: 'public_doc_space', kind: 'project', ownerColumns: ['project_id'] },
  { table: 'question', kind: 'project', ownerColumns: ['project_id'] },
  {
    table: 'question_mutation_audit',
    kind: 'parent',
    parents: [{ table: 'question', column: 'question_id' }],
  },
  { table: 'release', kind: 'project', ownerColumns: ['project_id'] },
  { table: 'review', kind: 'project', ownerColumns: ['project_id'] },
  {
    table: 'review_finding',
    kind: 'parent',
    parents: [{ table: 'review', column: 'review_id' }],
  },
  {
    table: 'review_lens',
    kind: 'parent',
    parents: [{ table: 'review', column: 'review_id' }],
  },
  { table: 'review_read', kind: 'project', ownerColumns: ['project_id'] },
  { table: 'run', kind: 'project', ownerColumns: ['project_id'] },
  {
    table: 'run_exclusion',
    kind: 'parent',
    parents: [{ table: 'run', column: 'run_id' }],
  },
  {
    table: 'run_score',
    kind: 'parent',
    parents: [{ table: 'run', column: 'run_id' }],
  },
  { table: 'secret_dek', kind: 'space', reason: 'space encryption key' },
  {
    table: 'secret_dek_wrap',
    kind: 'space',
    reason: 'space encryption key wrapping',
  },
  { table: 'seq', kind: 'project', ownerColumns: ['project_id'] },
  {
    table: 'step_catalogue',
    kind: 'space',
    reason: 'space workflow catalogue',
  },
  {
    table: 'step_catalogue_event',
    kind: 'space',
    reason: 'space workflow catalogue history',
  },
  {
    table: 'step_catalogue_version',
    kind: 'space',
    reason: 'space workflow catalogue version',
  },
  { table: 'subject', kind: 'project', ownerColumns: ['project_id'] },
  { table: 'test_flake', kind: 'project', ownerColumns: ['project_id'] },
  { table: 'workflow', kind: 'space', reason: 'space workflow catalogue' },
  { table: 'workflow_event', kind: 'space', reason: 'space workflow history' },
  {
    table: 'workflow_version',
    kind: 'space',
    reason: 'space workflow version',
  },
] as const satisfies readonly ProjectSpaceOwnership[]

/** Project references that identify a related source but do not own the row. */
export const NON_OWNING_PROJECT_REFERENCES = [
  { table: 'board_claim', column: 'project_id' },
  { table: 'board_message', column: 'author_project_id' },
  { table: 'hub_report_subscription_project', column: 'project_id' },
  { table: 'port_pair', column: 'source_project_id' },
  { table: 'port_ref_source', column: 'source_project_id' },
] as const
