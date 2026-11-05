import type { InfrastructureIdentity } from './identity-inventory.ts'

export const INFRASTRUCTURE_IDENTITIES: readonly InfrastructureIdentity[] = [
  {
    store: 'orchestrator',
    table: 'collect_change_counter',
    reason: 'singleton local collector sequence',
  },
  { store: 'orchestrator', table: 'orch_migrations', reason: 'migration journal bookkeeping' },
  {
    store: 'orchestrator',
    table: 'hosted_board_message_tag_cache',
    reason:
      'machine-local pull-only mirror of hosted board_message_tag written by orchestrator/src/board/board-hosted-cache.ts; no synced source and no foreign key from a synced source',
  },
  {
    store: 'orchestrator',
    table: 'branch_landing_record',
    reason:
      'machine-local landing evidence written by orchestrator/src/branch/branch-landing-service.ts and read by local views; no outbox kind, no synced source, and no foreign key from a synced source',
  },
  {
    store: 'orchestrator',
    table: 'question_delivery',
    reason:
      'machine-local delivery ledger; orchestrator/src/run/question-outbox.ts carries question_mutation_audit rather than deliveries, and the integer id is only an output label',
  },
  {
    store: 'orchestrator',
    table: 'board_hosted_adoption_receipt',
    reason:
      'machine-local hosted-adoption ledger read only in orchestrator/src/board/board-adoption.ts; never pushed',
  },
  {
    store: 'orchestrator',
    table: 'outbox',
    reason:
      'machine-local sync delivery queue (DEV-1214 out of scope: the outbox builds on the record); hosted identity is the payload UUID, and the integer is a per-machine insertion sequence and transport correlation',
  },
  {
    store: 'orchestrator',
    table: 'outbox_quarantine_audit',
    reason: 'machine-local forensics of the outbox queue; not synced',
  },
  {
    store: 'orchestrator',
    table: 'outbox_redaction_audit',
    reason: 'machine-local forensics of the outbox queue; not synced',
  },
  { store: 'orchestrator', table: 'orch_schema_lock', reason: 'schema migration lock' },
  { store: 'orchestrator', table: 'record_install_binding', reason: 'singleton install binding' },
  { store: 'orchestrator', table: 'board_reach_recording', reason: 'singleton reach cursor' },
  { store: 'orchestrator', table: 'schema_meta', reason: 'schema metadata keyed by setting name' },
  { store: 'orchestrator', table: 'session_seen', reason: 'replaceable session liveness cache' },
  { store: 'orchestrator', table: 'host_pressure_sample', reason: 'bounded machine sample cache' },
  { store: 'orchestrator', table: 'presence', reason: 'replaceable session presence cache' },
  { store: 'orchestrator', table: 'main_stack_activity', reason: 'replaceable activity cache' },
  { store: 'hub', table: 'hub_migrations', reason: 'migration journal bookkeeping' },
  {
    store: 'hub',
    table: 'question_delivery',
    reason:
      'machine-local ingest copy rebuilt per run by hub/src/ingest/runs.ts; no synced source and no foreign key from a synced source',
  },
  {
    store: 'hub',
    table: 'operator_waiting_email',
    reason:
      'machine-local dedupe ledger for episodes already pushed by hub/src/operator-waiting-email.ts; the hosted row is minted separately',
  },
  {
    store: 'hub',
    table: 'seq',
    reason:
      'machine-local task numbering in hub/src/task.ts; hosted seq is recomputed from hosted hub_task by hub/src/hosted-tasks.ts',
  },
  {
    store: 'hub',
    table: 'setting',
    reason:
      'machine-local key/value state including hosted-cache cursors in hub/src/hosted-change-cache.ts and task-adoption counters in hub/src/task-adoption.ts',
  },
  {
    store: 'hub',
    table: 'commit_key',
    reason:
      'machine-local Git ingestion in hub/src/ingest/git.ts and hub/src/task-import.ts, keyed by content-addressed commit sha',
  },
  {
    store: 'hub',
    table: 'task_identity_claim',
    reason: 'machine-local task identity cache read in hub/src/task-identity.ts',
  },
  {
    store: 'hub',
    table: 'task_identity_migration_repairs',
    reason:
      'machine-local task identity repair audit written by hub/migrations/0009_task_record_identity.sql and hub/src/ingest/trackers.ts',
  },
  { store: 'hub', table: 'hub_schema_lock', reason: 'schema migration lock' },
  { store: 'hub', table: 'install_binding', reason: 'singleton install binding' },
]
