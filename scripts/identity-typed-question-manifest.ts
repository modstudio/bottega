import type { ManifestColumn } from './identity-inventory.ts'

const column = (column: string, reason: string): ManifestColumn => ({
  store: 'orchestrator',
  column,
  reason,
})
const hubColumn = (column: string, reason: string): ManifestColumn => ({
  store: 'hub',
  column,
  reason,
})

export const TYPED_QUESTION_IDENTITY = {
  integerValues: [
    column('typed_question_answer.question_version', 'version'),
    column('typed_question_answer.input_tokens', 'measurement'),
    column('typed_question_answer.latency_ms', 'measurement'),
    hubColumn('typed_question_answer.question_version', 'version'),
    hubColumn('typed_question_answer.input_tokens', 'measurement'),
    hubColumn('typed_question_answer.latency_ms', 'measurement'),
    hubColumn('typed_question_outcome.question_version', 'version'),
    hubColumn('typed_question_outcome.label', 'boolean label'),
  ],
  externalIdentifiers: [
    column('typed_question_answer.question_id', 'stable id declared by the question registry'),
    column('typed_question_answer.subject_ref', 'content-derived subject identity'),
    column('typed_question_answer.state_sha', 'content-derived state identity'),
    hubColumn('typed_question_answer.question_id', 'stable id declared by the question registry'),
    hubColumn('typed_question_answer.subject_ref', 'content-derived subject identity'),
    hubColumn('typed_question_answer.state_sha', 'content-derived state identity'),
    hubColumn('typed_question_outcome.question_id', 'stable id declared by the question registry'),
    hubColumn('typed_question_outcome.subject_ref', 'content-derived subject identity'),
  ],
  uuids: [
    column('typed_question_answer.record_id', 'owned UUID'),
    hubColumn('typed_question_answer.record_id', 'owned UUID'),
    hubColumn('typed_question_outcome.record_id', 'owned UUID'),
  ],
} as const
