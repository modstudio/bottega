import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { newRecordId } from '../../../shared/record-id.ts'
import { renderRecordApiRefusal } from './record-api-errors.ts'
import { registerRecordQuestionRoutes } from './record-api-question.ts'
import type { RecordIdentity } from './record-auth.ts'
import { type QuestionWriteBody, RecordQuestionError } from './record-question-contract.ts'

const stamp = '2026-11-15T12:00:00.000Z'

function questionWrite(): QuestionWriteBody {
  return {
    requestId: newRecordId(),
    question: {
      id: newRecordId(),
      number: 1,
      runId: null,
      workflowKey: null,
      workflowTaskId: null,
      workflowCursorRecordId: null,
      projectId: null,
      machineId: newRecordId(),
      revision: 2,
      askedAt: stamp,
      question: 'Proceed?',
      options: null,
      recommendation: null,
      why: null,
      askedVia: 'workflow',
      kind: 'text',
      typedOptions: null,
      criteria: null,
      levels: null,
      answer: 'yes',
      answerValue: null,
      answerBasis: null,
      answeredAt: stamp,
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
      createdAt: stamp,
      updatedAt: stamp,
    },
    audit: { action: 'answer', actorSession: null, at: stamp, reason: null },
  }
}

test('a direct question write refusal renders its status and message', async () => {
  const refusal = new RecordQuestionError('question already holds hosted revision 2', 409)
  const app = new Hono<{
    Variables: { identity: RecordIdentity; destinationSpaceId?: string }
  }>()
  app.onError((error, context) => renderRecordApiRefusal(context, error) ?? context.text('', 500))
  registerRecordQuestionRoutes(
    app,
    {
      writeQuestion: async () => {
        throw refusal
      },
    },
    {
      scope: () => ({
        url: 'postgres://unused.test/record',
        userId: newRecordId(),
        spaceId: newRecordId(),
        spaceIds: [],
      }),
      noSpace: (context) => context.json({ error: 'no space' }, 409),
    },
  )

  const response = await app.request('/v1/questions/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(questionWrite()),
  })
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: refusal.message })
})
