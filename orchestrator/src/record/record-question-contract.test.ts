import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  isMembershipQuestionRead,
  QUESTION_JSON_FIELDS,
  type QuestionReadInput,
  type QuestionWriteBody,
  questionJsonFieldStructuredMessage,
  questionWriteSchema,
} from './record-question-contract.ts'

const STAMP = '2026-11-16T12:00:00.000Z'

test.each([
  [{ read: 'inbox' }, true],
  [{ read: 'inbox', limit: 1 }, false],
  [{ read: 'inbox', changedAfter: '0' }, false],
  [{ read: 'open-for-tasks', taskRecordIds: [newRecordId()] }, true],
  [{ read: 'waiting' }, false],
] satisfies Array<[QuestionReadInput, boolean]>)('membership question read %j is %s', (input, expected) => {
  expect(isMembershipQuestionRead(input)).toBe(expected)
})

function questionWrite(): QuestionWriteBody {
  return {
    requestId: newRecordId(),
    question: {
      id: newRecordId(),
      number: null,
      runId: null,
      workflowKey: null,
      workflowTaskId: null,
      workflowCursorRecordId: null,
      projectId: null,
      machineId: newRecordId(),
      revision: 1,
      askedAt: STAMP,
      question: 'Proceed?',
      options: null,
      recommendation: null,
      why: null,
      askedVia: 'live',
      kind: 'choice',
      typedOptions: null,
      criteria: null,
      levels: null,
      answer: null,
      answerValue: null,
      answerBasis: null,
      answeredAt: null,
      answeredBy: null,
      answeredByName: null,
      answeredByKind: null,
      answererKind: null,
      answerChannel: null,
      jevPick: null,
      jevConfidence: null,
      jevProbabilities: null,
      jevModel: null,
      jevInputTokens: null,
      jevError: null,
      jevAgreed: null,
      jevQuestionVersion: null,
      jevFits: null,
      jevOrderFlipped: null,
      awaitingOperatorAt: null,
      relayedBy: null,
      overturnedAt: null,
      overturnedBy: null,
      overturnedByName: null,
      overturnReason: null,
      replacement: null,
      filedAs: null,
      filedRef: null,
      filedRecordId: null,
      filedLabel: null,
      filedAt: null,
      closedAt: null,
      closeReason: null,
      withheldFields: [],
      createdAt: STAMP,
      updatedAt: STAMP,
    },
    audit: { action: 'ask', actorSession: 'test-session', at: STAMP, reason: null },
  }
}

test.each(QUESTION_JSON_FIELDS)('hosted question writes refuse string-valued %s', (field) => {
  const encoded = questionWrite()
  ;(encoded.question as unknown as Record<string, unknown>)[field] = '[]'
  const rejected = questionWriteSchema.safeParse(encoded)
  expect(rejected.success).toBe(false)
  if (!rejected.success)
    expect(rejected.error.issues).toContainEqual(
      expect.objectContaining({
        path: ['question', field],
        message: questionJsonFieldStructuredMessage(field),
      }),
    )

  const structured = questionWrite()
  ;(structured.question as unknown as Record<string, unknown>)[field] = [{ name: 'First' }]
  expect(questionWriteSchema.safeParse(structured).success).toBe(true)
})
