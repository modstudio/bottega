import { PUSHABLE_HUB_CHANGE_TABLES } from '../hub/src/push-contract.ts'
import type { OUTBOX_PAYLOAD_CONTRACTS } from '../orchestrator/src/record/outbox-payload-contracts.ts'

type OutboxSource = { source: string; tables: readonly string[]; reason: string }

export const OUTBOX_KIND_SOURCES: Readonly<
  Record<keyof typeof OUTBOX_PAYLOAD_CONTRACTS, OutboxSource>
> = {
  run: { source: 'run', tables: ['run'], reason: 'enqueued from run' },
  score: { source: 'score', tables: ['score'], reason: 'enqueued from score' },
  question: {
    source: 'question',
    tables: ['question', 'question_mutation_audit'],
    reason: 'enqueued from question with its mutation audit rows',
  },
  task_flow: { source: 'task_flow', tables: ['task_flow'], reason: 'enqueued from task_flow' },
  task_flow_stage: {
    source: 'workflow_cursor',
    tables: ['workflow_cursor'],
    reason: 'enqueued from workflow_cursor',
  },
  review: { source: 'review', tables: ['review'], reason: 'enqueued from review' },
  review_lens: {
    source: 'review_lens',
    tables: ['review_lens'],
    reason: 'enqueued from review_lens',
  },
  review_finding: {
    source: 'review_finding',
    tables: ['review_finding'],
    reason: 'enqueued from review_finding',
  },
  review_read: {
    source: 'review_read',
    tables: ['review_read'],
    reason: 'enqueued from review_read',
  },
  release: {
    source: 'release_ledger',
    tables: ['release_ledger'],
    reason: 'release is enqueued from release_ledger by release/release-outbox.ts',
  },
  landing: { source: 'landing', tables: ['landing'], reason: 'enqueued from landing' },
  landing_override: {
    source: 'landing_override',
    tables: ['landing_override'],
    reason: 'enqueued from landing_override',
  },
  landing_review_carry: {
    source: 'landing_review_carry',
    tables: ['landing_review_carry'],
    reason: 'enqueued from landing_review_carry',
  },
  landing_triage_snapshot: {
    source: 'landing_triage_snapshot',
    tables: ['landing_triage_snapshot'],
    reason: 'enqueued from landing_triage_snapshot',
  },
  pull_request_ci: {
    source: 'pull_request_ci',
    tables: ['pull_request_ci'],
    reason: 'enqueued from pull_request_ci',
  },
  contention: {
    source: 'contention',
    tables: ['contention'],
    reason: 'enqueued from contention',
  },
  test_flake: {
    source: 'test_flake',
    tables: ['test_flake'],
    reason: 'enqueued from test_flake',
  },
  branch_disposal: {
    source: 'branch_disposal',
    tables: ['branch_disposal'],
    reason: 'enqueued from branch_disposal',
  },
}

export const PUSHABLE_HUB_TABLES = PUSHABLE_HUB_CHANGE_TABLES.map((hosted) => ({
  hosted,
  local: hosted.replace(/^hub_/, ''),
}))

export const STATE_CLASS_OUTBOX_TABLES = [
  ...new Set(
    Object.values(OUTBOX_KIND_SOURCES).flatMap(({ tables }) =>
      tables.map((table) => `orchestrator.${table}`),
    ),
  ),
  ...PUSHABLE_HUB_TABLES.map(({ local }) => `hub.${local}`),
]
