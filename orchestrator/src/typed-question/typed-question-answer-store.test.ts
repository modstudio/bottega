import { expect, test } from 'bun:test'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { recordTypedQuestionAnswer } from './typed-question-answer-store.ts'

const database = testDatabaseFixture(() => {})

test('records a typed-question evidence row with a UUID identity', () => {
  const d = database()
  recordTypedQuestionAnswer(
    {
      questionId: 'spec_unsettled',
      questionVersion: 1,
      subjectKind: 'spec',
      subjectRef: '0123456789abcdef',
      stateSha: 'a'.repeat(64),
      answerJson: JSON.stringify({ noul: 0.91 }),
      model: 'jev-served',
      inputTokens: 123,
      latencyMs: 45,
      error: null,
    },
    d,
  )

  expect(
    d
      .query(
        `SELECT question_id,question_version,subject_kind,subject_ref,state_sha,answer_json,
              model,input_tokens,latency_ms,error,created_at,
              record_id GLOB '????????-????-????-????-????????????' AS uuid_shaped
       FROM typed_question_answer`,
      )
      .get(),
  ).toEqual({
    question_id: 'spec_unsettled',
    question_version: 1,
    subject_kind: 'spec',
    subject_ref: '0123456789abcdef',
    state_sha: 'a'.repeat(64),
    answer_json: JSON.stringify({ noul: 0.91 }),
    model: 'jev-served',
    input_tokens: 123,
    latency_ms: 45,
    error: null,
    created_at: expect.any(String),
    uuid_shaped: 1,
  })
})
