import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record-id.ts'
import { typedQuestionStateIdentity } from '../../shared/typed-question/state-identity.ts'
import { db, writeTransaction } from './db.ts'
import { NOTE_DUPLICATE_QUESTION } from './note-duplicate-question.ts'
import { askHubTypedQuestion } from './typed-question-service.ts'

const state = { existing: 'the gate stalls', new: 'gate stalls under load' }

function seedAnswer(subjectRef: string): void {
  writeTransaction((database) => {
    database
      .query(
        `INSERT INTO typed_question_answer
         (record_id,question_id,question_version,subject_kind,subject_ref,state_sha,answer_json,
          model,input_tokens,latency_ms,error,created_at)
         VALUES (?,?,?,'note-pair',?,?,'{"noul":0.91}','jev',1,1,NULL,'2026-01-01T00:00:00Z')`,
      )
      .run(
        newRecordId(),
        NOTE_DUPLICATE_QUESTION.id,
        NOTE_DUPLICATE_QUESTION.version,
        subjectRef,
        typedQuestionStateIdentity(state),
      )
  })
}

test('reuses the recorded answer for the same subject and state without asking', async () => {
  const subjectRef = newRecordId()
  seedAnswer(subjectRef)
  const answer = await askHubTypedQuestion(
    { question: NOTE_DUPLICATE_QUESTION, subjectKind: 'note-pair', subjectRef, state },
    {
      ask: async () => {
        throw new Error('asked despite a recorded answer')
      },
      database: db,
      record: () => {
        throw new Error('recorded despite a recorded answer')
      },
    },
  )
  expect(answer).toEqual({ noul: 0.91 })
})

test('asks and records again when the state differs from the recorded one', async () => {
  const subjectRef = newRecordId()
  seedAnswer(subjectRef)
  const recorded: (string | number | null)[][] = []
  const answer = await askHubTypedQuestion(
    {
      question: NOTE_DUPLICATE_QUESTION,
      subjectKind: 'note-pair',
      subjectRef,
      state: { ...state, existing: 'a different note' },
    },
    {
      ask: async () => ({
        kind: 'answer',
        answer: { noul: 0.2 },
        model: 'jev',
        inputTokens: 1,
        latencyMs: 1,
      }),
      database: db,
      record: (_database, values) => {
        recorded.push([...values])
      },
    },
  )
  expect(answer).toEqual({ noul: 0.2 })
  expect(recorded).toHaveLength(1)
  expect(recorded[0]?.[4]).toBe(subjectRef)
})
