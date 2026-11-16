import { expect, test } from 'bun:test'
import { questionWriteSchema } from '../record/record-question-contract.ts'
import { questionSnapshotFromRow } from './question-store-mutation.ts'

const ID = '00000000-0000-4000-8000-000000000001'

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    record_id: ID,
    number: 1,
    run_record_id: null,
    workflow_key: null,
    workflow_task_record_id: null,
    workflow_cursor_record_id: null,
    project_record_id: null,
    machine_id: ID,
    revision: 1,
    asked_at: '2026-11-16 20:09:29.002345+00',
    question: 'Proceed?',
    options: null,
    recommendation: null,
    why: null,
    asked_via: null,
    kind: null,
    typed_options: null,
    criteria: null,
    levels: null,
    answer: null,
    answer_value: null,
    answer_basis: null,
    answered_at: '2026-11-16 15:09:29.002345-05',
    answered_by: null,
    answered_by_name: null,
    answered_by_kind: null,
    answerer_kind: null,
    answer_channel: null,
    jev_pick: null,
    jev_confidence: null,
    jev_probabilities: null,
    jev_model: null,
    jev_input_tokens: null,
    jev_error: null,
    jev_agreed: null,
    jev_question_version: null,
    jev_fits: null,
    jev_order_flipped: null,
    awaiting_operator_at: null,
    relayed_by: null,
    overturned_at: null,
    overturned_by: null,
    overturned_by_name: null,
    overturn_reason: null,
    replacement: null,
    filed_as: null,
    filed_ref: null,
    filed_record_id: null,
    filed_label: null,
    filed_at: null,
    closed_at: null,
    close_reason: null,
    withheld_fields: [],
    created_at: '2026-11-16 20:09:29.002345+00',
    updated_at: '2026-11-16 20:09:29.002345+00',
    ...overrides,
  }
}

test('question snapshots normalize Postgres and Date timestamps to strict ISO instants', () => {
  const postgres = questionSnapshotFromRow(row())
  expect(questionWriteSchema.shape.question.safeParse(postgres).success).toBe(true)
  expect(postgres.askedAt).toBe('2026-11-16T20:09:29.002Z')
  expect(postgres.answeredAt).toBe(postgres.askedAt)

  const instant = new Date('2026-11-16T20:09:29.002Z')
  const dates = questionSnapshotFromRow(
    row({
      asked_at: instant,
      answered_at: instant,
      awaiting_operator_at: instant,
      overturned_at: instant,
      filed_at: instant,
      closed_at: instant,
      created_at: instant,
      updated_at: instant,
    }),
  )
  expect(questionWriteSchema.shape.question.safeParse(dates).success).toBe(true)
  expect([
    dates.askedAt,
    dates.answeredAt,
    dates.awaitingOperatorAt,
    dates.overturnedAt,
    dates.filedAt,
    dates.closedAt,
    dates.createdAt,
    dates.updatedAt,
  ]).toEqual(Array(8).fill(instant.toISOString()))
})

test('question snapshot timestamp failures name the field', () => {
  expect(() => questionSnapshotFromRow(row({ asked_at: new Date(Number.NaN) }))).toThrow('askedAt')
})
