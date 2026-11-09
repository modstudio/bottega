import { PUSHABLE_HUB_CHANGE_TABLES } from '../hub/src/push-contract.ts'
import type { OUTBOX_PAYLOAD_CONTRACTS } from '../orchestrator/src/record/outbox-payload-contracts.ts'

export type OutboxSource = {
  source: string
  carries?: readonly string[]
  reason?: string
}

export const OUTBOX_KIND_SOURCES: Readonly<
  Record<keyof typeof OUTBOX_PAYLOAD_CONTRACTS, OutboxSource>
> = {
  run: { source: 'run' },
  score: { source: 'score' },
  question: {
    source: 'question',
    carries: ['question_mutation_audit'],
    reason: 'question payloads fold in mutation audit rows that are not enqueued themselves',
  },
  task_flow: { source: 'task_flow' },
  task_flow_stage: { source: 'workflow_cursor' },
  review: { source: 'review' },
  review_lens: { source: 'review_lens' },
  review_finding: { source: 'review_finding' },
  review_read: { source: 'review_read' },
  release: {
    source: 'release_ledger',
    reason: 'release is enqueued from release_ledger by release/release-outbox.ts',
  },
  landing: { source: 'landing' },
  landing_override: { source: 'landing_override' },
  landing_review_carry: { source: 'landing_review_carry' },
  landing_triage_snapshot: { source: 'landing_triage_snapshot' },
  pull_request_ci: { source: 'pull_request_ci' },
  contention: { source: 'contention' },
  test_flake: { source: 'test_flake' },
  branch_disposal: { source: 'branch_disposal' },
}

export const PUSHABLE_HUB_TABLES = PUSHABLE_HUB_CHANGE_TABLES.map((hosted) => ({
  hosted,
  local: hosted.replace(/^hub_/, ''),
}))

export const STATE_CLASS_OUTBOX_TABLES = [
  ...new Set(
    Object.values(OUTBOX_KIND_SOURCES).flatMap(({ source, carries = [] }) =>
      [source, ...carries].map((table) => `orchestrator.${table}`),
    ),
  ),
  ...PUSHABLE_HUB_TABLES.map(({ local }) => `hub.${local}`),
]
