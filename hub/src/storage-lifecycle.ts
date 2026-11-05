// concern: hub storage lifecycle
/** Declares the lifecycle of every hub SQLite table. */

import {
  boundedMachine as sharedBoundedMachine,
  entries as sharedEntries,
  type TableLifecycle,
} from '../../shared/storage-lifecycle.ts'

const entries = sharedEntries.bind(null, 'hub')
const boundedMachine = sharedBoundedMachine.bind(null, 'hub')

export const hubTableLifecycles: readonly TableLifecycle[] = [
  ...entries(
    [
      'day',
      'note_acknowledgement',
      'note_counter',
      'operator_waiting_email',
      'question',
      'send',
      'task',
      'task_comment',
      'task_document',
      'task_status_event',
    ],
    'cache',
    null,
    'working-set',
  ),
  ...entries(['typed_question_answer', 'typed_question_outcome'], 'record', 'kept'),
  ...entries(['question_delivery'], 'journal', null, 'outbox'),
  ...entries(['interval'], 'telemetry', null, 'telemetry'),
  ...entries(
    ['commit_key', 'task_identity_claim', 'transcript_fingerprint'],
    'machine',
    null,
    'working-set',
  ),
  ...boundedMachine(
    ['hub_schema_lock', 'install_binding', 'seq'],
    'The single machine-local row is kept for the lifetime of this installation.',
  ),
  ...boundedMachine(
    ['setting'],
    'One row per declared machine-local setting key is kept for the lifetime of that key.',
  ),
  ...boundedMachine(
    ['hub_migrations'],
    'One immutable row per applied migration is kept for the lifetime of the store.',
  ),
  ...entries(['note'], 'cache', 'hub/src/note-staleness-store.ts#applyLocalStaleness'),
  ...entries(['hosted_outbox'], 'journal', 'hub/src/outbox.ts#drainHostedOutbox'),
  {
    store: 'hub',
    table: 'hosted_outbox_trace',
    class: 'journal',
    keep: 'Delivery trace rows stay for OUTBOX_TRACE_RETENTION_MS.',
    remover: 'hub/src/outbox-trace.ts#pruneOutboxTrace',
  },
  ...entries(
    ['task_identity_migration_repairs'],
    'machine',
    'hub/src/ingest/trackers.ts#ingestTrackers',
  ),
]
