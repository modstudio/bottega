import type { ManifestColumn } from './identity-inventory.ts'

const column = (column: string, reason: string): ManifestColumn => ({
  store: 'orchestrator',
  column,
  reason,
})

export const TYPED_QUESTION_IDENTITY = {
  integerValues: [
    column('typed_question_answer.question_version', 'version'),
    column('typed_question_answer.input_tokens', 'measurement'),
    column('typed_question_answer.latency_ms', 'measurement'),
  ],
  externalIdentifiers: [
    column('typed_question_answer.question_id', 'stable id declared by the question registry'),
    column('typed_question_answer.subject_ref', 'content-derived subject identity'),
    column('typed_question_answer.state_sha', 'content-derived state identity'),
  ],
  uuids: [column('typed_question_answer.record_id', 'owned UUID')],
} as const
