import { IDENTITY_STATE_CLASSES } from '../shared/identity-state-classes.ts'
import type { StateClassStore } from './identity-inventory.ts'

export type TableStateClassDeclaration = {
  store: StateClassStore
  table: string
  class: 'hosted' | 'synced' | 'machine'
  reason: string
  counterpart?: string
  cache?: true
  task?: string
  ruling?: string
}

type MachineStateFileDeclaration = {
  store: 'state-directory'
  path: string
  class: 'machine'
  reason: string
  ruling: string
}

export type StateClassDeclaration = TableStateClassDeclaration | MachineStateFileDeclaration

const PORTABLE_RULING =
  'Shmuel Barkin, 2026-11-01: all work is portable; machine only for state another machine would never care about'
const LABEL_RULING = 'Shmuel Barkin, DEV-1214/15 option (a): machine-scoped labels'
const DEV_2234_MACHINE_RULING =
  'Shmuel Barkin, DEV-2234 ruling 6: planned tables split by who acts; machine resources are machine'
const QUESTION_REFERENCE_MACHINE_RULING =
  'Shmuel Barkin, q6436: local question references are machine state'
const QUESTION_DELIVERY_PENDING_MACHINE_RULING =
  'Shmuel Barkin, chat 2026-11-16: pending question delivery is machine state'

const synced = (
  store: StateClassStore,
  table: string,
  reason: string,
  task?: string,
): TableStateClassDeclaration => ({
  store,
  table,
  class: 'synced',
  reason,
  ...(task ? { task } : {}),
})

const hosted = (
  store: StateClassStore,
  table: string,
  counterpart: string,
  reason: string,
): TableStateClassDeclaration => ({ store, table, class: 'hosted', reason, counterpart })

const cache = (
  store: StateClassStore,
  table: string,
  counterpart: string,
  reason: string,
): TableStateClassDeclaration => ({
  store,
  table,
  class: 'hosted',
  reason,
  counterpart,
  cache: true,
})

const planned = (
  store: StateClassStore,
  table: string,
  task: string,
  reason: string,
): TableStateClassDeclaration => ({ store, table, class: 'hosted', reason, task })

const machine = (
  store: StateClassStore,
  table: string,
  reason: string,
  ruling: string,
): TableStateClassDeclaration => ({ store, table, class: 'machine', reason, ruling })

export const STATE_CLASSES: readonly StateClassDeclaration[] = [
  {
    store: 'state-directory',
    path: 'orchestrator/claude-mcp-placement.json',
    class: 'machine',
    reason:
      'Records the Claude MCP scopes applied on this machine to avoid session-start CLI reads',
    ruling: PORTABLE_RULING,
  },
  machine(
    'orchestrator',
    'collect_change_counter',
    "This machine's collector change cursor",
    PORTABLE_RULING,
  ),
  machine(
    'orchestrator',
    'agent',
    'Agents installed and probed on this machine',
    DEV_2234_MACHINE_RULING,
  ),
  synced('orchestrator', 'blocker', 'Blockers observed during runs', 'DEV-2234'),
  synced('orchestrator', 'brief_injection', 'SessionStart context delivery events', 'DEV-2293'),
  synced('orchestrator', 'context_review', 'Timed context review events', 'DEV-2354'),
  synced('orchestrator', 'hook_emission', 'Product-hook output measurements', 'DEV-2343'),
  hosted('orchestrator', 'board_claim', 'board_claim', 'Local board claim mirror'),
  machine(
    'orchestrator',
    'board_hosted_adoption_ledger',
    'This machine tracks local rows moving to the record',
    PORTABLE_RULING,
  ),
  machine(
    'orchestrator',
    'board_hosted_adoption_receipt',
    'This machine tracks local rows moved to the record',
    PORTABLE_RULING,
  ),
  hosted('orchestrator', 'board_message', 'board_message', 'Local board message mirror'),
  hosted('orchestrator', 'board_message_tag', 'board_message_tag', 'Local board tag mirror'),
  planned(
    'orchestrator',
    'board_reach_delivery',
    'DEV-2234',
    'Deliveries that make board messages reachable',
  ),
  machine(
    'orchestrator',
    'board_reach_recording',
    "This machine's delivery cursor",
    PORTABLE_RULING,
  ),
  machine(
    'orchestrator',
    'board_reach_recording_failure',
    "This machine's delivery failures",
    PORTABLE_RULING,
  ),
  hosted('orchestrator', 'board_receipt', 'board_receipt', 'Local board receipt mirror'),
  planned(
    'orchestrator',
    'board_withdrawal_delivery',
    'DEV-2234',
    'Deliveries that withdraw board messages',
  ),
  synced('orchestrator', 'branch_disposal', 'Outbox source for branch disposal'),
  synced('orchestrator', 'branch_landing_record', 'Branch landing outcomes', 'DEV-2234'),
  synced('orchestrator', 'calibration', 'Calibration outcomes', 'DEV-2234'),
  synced('orchestrator', 'canon_eval', 'Canon evaluation outcomes', 'DEV-2234'),
  machine(
    'orchestrator',
    'canon_pack',
    'A compiled pack that any machine rebuilds',
    PORTABLE_RULING,
  ),
  synced('orchestrator', 'check_execution', 'Check execution outcomes', 'DEV-2234'),
  synced('orchestrator', 'compared_pair', 'Compared routing evidence pairs', 'DEV-2234'),
  synced('orchestrator', 'contention', 'Outbox source for contention'),
  machine('orchestrator', 'contention_day', "This machine's contention rollup", PORTABLE_RULING),
  hosted('orchestrator', 'doc', 'doc', 'Local document write source'),
  hosted(
    'orchestrator',
    'doc_related_subject',
    'doc_related_subject',
    'Local document subject link',
  ),
  hosted('orchestrator', 'doc_revision', 'doc_revision', 'Local document revision write source'),
  hosted('orchestrator', 'context_item', 'context_item', 'Local context item write source'),
  synced('orchestrator', 'duel', 'Duel outcomes', 'DEV-2234'),
  machine('orchestrator', 'entity_number_counter', 'Machine-scoped display labels', LABEL_RULING),
  synced('orchestrator', 'gate_execution', 'Gate execution outcomes', 'DEV-2234'),
  synced('orchestrator', 'review_funnel_decision', 'Replayable review-funnel verdicts', 'DEV-2299'),
  machine('orchestrator', 'host_pressure_sample', "This machine's host telemetry", PORTABLE_RULING),
  cache(
    'orchestrator',
    'hosted_board_message_cache',
    'board_message',
    'Hosted board message cache',
  ),
  cache(
    'orchestrator',
    'hosted_board_message_tag_cache',
    'board_message_tag',
    'Hosted board tag cache',
  ),
  cache(
    'orchestrator',
    'hosted_board_receipt_cache',
    'board_receipt',
    'Hosted board receipt cache',
  ),
  machine(
    'orchestrator',
    'hosted_pressure_cache',
    "This machine's hosted-pressure probe cache",
    PORTABLE_RULING,
  ),
  machine(
    'orchestrator',
    'hosted_call_outcome',
    "This machine's hosted-call outcomes",
    "Shmuel Barkin's ruling on DEV-2036 (2026-11-02): a local machine table",
  ),
  synced('orchestrator', 'landing', 'Outbox source for landing'),
  synced('orchestrator', 'landing_override', 'Outbox source for landing override'),
  synced('orchestrator', 'landing_review_carry', 'Outbox source for landing review carry'),
  synced('orchestrator', 'landing_triage_snapshot', 'Outbox source for landing triage snapshot'),
  hosted('orchestrator', 'lens', 'lens', 'Local lens write source'),
  hosted('orchestrator', 'lens_profile', 'lens_profile', 'Local lens profile write source'),
  hosted(
    'orchestrator',
    'lens_profile_revision',
    'lens_profile_revision',
    'Local lens profile revision',
  ),
  hosted('orchestrator', 'lens_revision', 'lens_revision', 'Local lens revision write source'),
  machine('orchestrator', 'main_stack_activity', "This machine's host telemetry", PORTABLE_RULING),
  machine('orchestrator', 'metric', "This machine's token metric", PORTABLE_RULING),
  machine('orchestrator', 'monitor_condition', "This machine's monitor condition", PORTABLE_RULING),
  machine(
    'orchestrator',
    'monitor_invocation',
    "This machine's monitor invocation",
    PORTABLE_RULING,
  ),
  machine(
    'orchestrator',
    'monitor_issue',
    "This machine's filed monitor issue keys",
    PORTABLE_RULING,
  ),
  machine(
    'orchestrator',
    'operator_notification',
    'Notifications waiting for operator delivery',
    QUESTION_REFERENCE_MACHINE_RULING,
  ),
  machine('orchestrator', 'orch_migrations', 'Local migration bookkeeping', PORTABLE_RULING),
  machine('orchestrator', 'orch_schema_lock', 'Local schema lock bookkeeping', PORTABLE_RULING),
  machine('orchestrator', 'outbox', 'Local outbox bookkeeping', PORTABLE_RULING),
  machine(
    'orchestrator',
    'outbox_quarantine_audit',
    'Local outbox quarantine audit',
    PORTABLE_RULING,
  ),
  machine(
    'orchestrator',
    'outbox_redaction_audit',
    'Local outbox redaction audit',
    PORTABLE_RULING,
  ),
  hosted('orchestrator', 'port_baseline', 'port_baseline', 'Local port baseline write source'),
  hosted('orchestrator', 'port_doctrine', 'port_doctrine', 'Local port doctrine write source'),
  hosted('orchestrator', 'port_pair', 'port_pair', 'Local port pair write source'),
  hosted('orchestrator', 'port_ref', 'port_ref', 'Local port reference write source'),
  hosted(
    'orchestrator',
    'port_ref_source',
    'port_ref_source',
    'Local port reference source write source',
  ),
  hosted('orchestrator', 'port_skip', 'port_skip', 'Local port skip write source'),
  machine('orchestrator', 'presence', "This machine's host telemetry", PORTABLE_RULING),
  synced('orchestrator', 'probe', 'Probe outcomes', 'DEV-2234'),
  hosted('orchestrator', 'project', 'project', 'Local project write source'),
  hosted(
    'orchestrator',
    'project_lens_profile',
    'project_lens_profile',
    'Local project lens selection',
  ),
  hosted(
    'orchestrator',
    'project_lens_profile_revision',
    'project_lens_profile_revision',
    'Local project lens revision',
  ),
  synced('orchestrator', 'pull_request_ci', 'Outbox source for pull request checks'),
  IDENTITY_STATE_CLASSES.question,
  machine(
    'orchestrator',
    'question_delivery',
    "This machine's question delivery state",
    QUESTION_REFERENCE_MACHINE_RULING,
  ),
  machine(
    'orchestrator',
    'question_delivery_pending',
    "This machine's pending question delivery state",
    QUESTION_DELIVERY_PENDING_MACHINE_RULING,
  ),
  hosted(
    'orchestrator',
    'question_mutation_audit',
    'question_mutation_audit',
    'Local question mutation audit',
  ),
  machine(
    'orchestrator',
    'record_install_binding',
    "This install's record binding",
    PORTABLE_RULING,
  ),
  machine(
    'orchestrator',
    'record_local_by_design',
    "This store's explicit local-authority mark",
    'Shmuel Barkin, DEV-2477: deliberately local stores carry a store-level local-by-design mark',
  ),
  synced('orchestrator', 'release_ledger', 'Outbox source for releases'),
  machine(
    'orchestrator',
    'resource_claim',
    'Resources claimed on this machine',
    DEV_2234_MACHINE_RULING,
  ),
  synced('orchestrator', 'review', 'Outbox source for reviews'),
  synced('orchestrator', 'review_finding', 'Outbox source for review findings'),
  synced('orchestrator', 'review_finding_amendment', 'Review finding amendments', 'DEV-2234'),
  synced('orchestrator', 'review_lens', 'Outbox source for review lenses'),
  synced('orchestrator', 'review_read', 'Outbox source for review reads'),
  machine(
    'orchestrator',
    'routing_pool_lens',
    'Pooled lens evidence used on this machine',
    DEV_2234_MACHINE_RULING,
  ),
  machine(
    'orchestrator',
    'routing_pool_run',
    'Pooled run evidence used on this machine',
    DEV_2234_MACHINE_RULING,
  ),
  IDENTITY_STATE_CLASSES.run,
  synced('orchestrator', 'run_carried_ruling', 'Rulings carried by runs', 'DEV-2234'),
  machine(
    'orchestrator',
    'run_checkpoint',
    'Pointers into local run worktrees',
    DEV_2234_MACHINE_RULING,
  ),
  synced('orchestrator', 'run_message', 'Messages recorded by runs', 'DEV-2234'),
  synced('orchestrator', 'run_mutation_audit', 'Run mutation audit entries', 'DEV-2234'),
  machine('orchestrator', 'schema_meta', 'Local schema bookkeeping', PORTABLE_RULING),
  synced('orchestrator', 'score', 'Outbox source for scores'),
  planned('orchestrator', 'session_board_hold', 'DEV-2234', 'Board holds owned by sessions'),
  machine('orchestrator', 'session_seen', "This machine's host telemetry", PORTABLE_RULING),
  machine(
    'orchestrator',
    'session_close_out',
    "This machine's completed session cleanup handoff",
    "Shmuel Barkin's approved DEV-2227/1 design, decision 6: close-out records are machine",
  ),
  machine(
    'orchestrator',
    'spawn',
    'Worker processes spawned on this machine',
    DEV_2234_MACHINE_RULING,
  ),
  hosted('orchestrator', 'step_catalogue', 'step_catalogue', 'Local step catalogue write source'),
  hosted(
    'orchestrator',
    'step_catalogue_event',
    'step_catalogue_event',
    'Local step catalogue event',
  ),
  hosted(
    'orchestrator',
    'step_catalogue_version',
    'step_catalogue_version',
    'Local step catalogue version',
  ),
  hosted('orchestrator', 'subject', 'subject', 'Local subject write source'),
  synced('orchestrator', 'test_flake', 'Outbox source for test flakes'),
  machine(
    'orchestrator',
    'worker_note_request',
    'Requests queued to the local note broker',
    DEV_2234_MACHINE_RULING,
  ),
  hosted('orchestrator', 'workflow', 'workflow', 'Local workflow catalogue write source'),
  hosted('orchestrator', 'task_flow', 'task_flow', 'Hosted workflow instances for tasks'),
  planned('orchestrator', 'typed_question_answer', 'DEV-2234', 'Typed-question answers'),
  planned('hub', 'typed_question_answer', 'DEV-2234', 'Typed-question answers'),
  planned('hub', 'typed_question_outcome', 'DEV-2234', 'Typed-question outcomes'),
  hosted(
    'orchestrator',
    'workflow_cursor',
    'task_flow_stage',
    'Hosted stages of workflow instances',
  ),
  hosted('orchestrator', 'workflow_event', 'workflow_event', 'Local workflow event write source'),
  hosted(
    'orchestrator',
    'workflow_obligation',
    'workflow_obligation',
    'Hosted obligations attached to workflow instances',
  ),
  hosted(
    'orchestrator',
    'workflow_step_text',
    'workflow_step_text',
    'Hosted text attached to workflow steps',
  ),
  hosted(
    'orchestrator',
    'workflow_text_copy',
    'workflow_text_copy',
    'Hosted copies of text attached to workflow instances',
  ),
  hosted(
    'orchestrator',
    'workflow_version',
    'workflow_version',
    'Local workflow version write source',
  ),
  machine('hub', 'commit_key', 'Local Git ingestion', PORTABLE_RULING),
  synced('hub', 'day', 'Daily usage collected on this machine'),
  machine('hub', 'hosted_outbox', 'Local hosted outbox bookkeeping', PORTABLE_RULING),
  machine('hub', 'hosted_outbox_trace', 'Local hosted outbox trace', PORTABLE_RULING),
  machine('hub', 'hub_migrations', 'Local migration bookkeeping', PORTABLE_RULING),
  machine('hub', 'hub_schema_lock', 'Local schema lock bookkeeping', PORTABLE_RULING),
  machine('hub', 'install_binding', "This install's record binding", PORTABLE_RULING),
  synced('hub', 'interval', 'Work intervals collected on this machine'),
  hosted('hub', 'note', 'hub_note', 'Local note write source'),
  hosted(
    'hub',
    'note_acknowledgement',
    'hub_note_acknowledgement',
    'Local note acknowledgement write source',
  ),
  hosted('hub', 'note_counter', 'project', 'Hosted project mints note numbers'),
  hosted(
    'hub',
    'operator_waiting_email',
    'operator_waiting_email',
    'Local waiting-email write source',
  ),
  cache('hub', 'question', 'question', 'Local mirror of hosted questions'),
  machine(
    'hub',
    'question_delivery',
    "Local copy of this machine's question delivery state",
    QUESTION_REFERENCE_MACHINE_RULING,
  ),
  cache('hub', 'send', 'hub_send', 'Local mirror of hosted report sends'),
  machine('hub', 'seq', 'Local sequence bookkeeping', PORTABLE_RULING),
  machine('hub', 'setting', 'Local cursors and hosted-cache cursors', PORTABLE_RULING),
  hosted('hub', 'task', 'hub_task', 'Local task write source'),
  hosted('hub', 'task_comment', 'hub_task_comment', 'Local task comment write source'),
  hosted('hub', 'task_document', 'hub_task_document', 'Local task document write source'),
  machine('hub', 'transcript_fingerprint', 'Local transcript collection cursor', PORTABLE_RULING),
  machine('hub', 'task_identity_claim', 'Local task identity cache', PORTABLE_RULING),
  machine(
    'hub',
    'task_identity_migration_repairs',
    'Local task identity repair audit',
    PORTABLE_RULING,
  ),
  hosted('hub', 'task_status_event', 'hub_task_status_event', 'Local task status write source'),
]
