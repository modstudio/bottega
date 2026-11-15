import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { QuestionSnapshot } from '../record/record-question-contract.ts'
import { questionRequestId } from '../record/record-question-contract.ts'
import { questionStore, recordQuestionStore } from './question-store.ts'
import type { QuestionStore } from './question-store-types.ts'

const STAMP = '2026-11-15T12:00:00.000Z'

function snapshot(overrides: Partial<QuestionSnapshot> = {}): QuestionSnapshot {
  return {
    id: newRecordId(),
    number: null,
    runId: null,
    workflowKey: 'DEV-2331',
    workflowTaskId: null,
    workflowCursorRecordId: newRecordId(),
    projectId: null,
    machineId: newRecordId(),
    revision: 1,
    askedAt: STAMP,
    question: 'Proceed?',
    options: null,
    recommendation: null,
    why: null,
    askedVia: 'workflow',
    kind: 'text',
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
    awaitingOperatorAt: STAMP,
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
    ...overrides,
  }
}

async function questionStoreContract(store: QuestionStore, question: QuestionSnapshot) {
  const requestId = questionRequestId('ask', [question.id])
  const ask = {
    requestId,
    question,
    audit: { action: 'ask', actorSession: 'session-a', at: STAMP, reason: null },
  }
  const first = await store.write('ask', ask)
  expect(first).toMatchObject({ id: question.id, number: 1, revision: 1 })
  expect(await store.write('ask', ask)).toEqual(first)
  expect((await store.read({ read: 'waiting' })).items).toHaveLength(1)
  const answeredAt = '2026-11-15T12:01:00.000Z'
  await store.write('answer', {
    requestId: questionRequestId('answer', [question.id, answeredAt]),
    question: {
      ...question,
      revision: 2,
      answer: 'Yes',
      answeredAt,
      answeredBy: 'architect',
      answeredByKind: 'architect',
      answererKind: 'agent',
      answerChannel: 'mcp',
      updatedAt: answeredAt,
    },
    audit: {
      action: 'rule',
      actorSession: 'session-a',
      at: answeredAt,
      reason: 'Yes',
    },
  })
  expect((await store.read({ read: 'waiting' })).items).toHaveLength(0)
}

test('SQLite and record question adapters satisfy the same write and read contract', async () => {
  const local = migratedTestDatabase()
  const hosted = migratedTestDatabase()
  local.exec('PRAGMA foreign_keys=OFF')
  hosted.exec('PRAGMA foreign_keys=OFF')
  const localStore = questionStore(local)
  const hostedStore = questionStore(hosted)
  await questionStoreContract(localStore, snapshot())
  await questionStoreContract(
    recordQuestionStore({
      database: local,
      destinationSpaceId: newRecordId(),
      pushRun: async () => {},
      client: {
        readQuestions: (input) => hostedStore.read(input),
        writeQuestion: (intent, input) => hostedStore.write(intent, input),
      },
    }),
    snapshot(),
  )
  local.close()
  hosted.close()
})

test('record ask pushes its run before writing and enriches inbox liveness locally', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  const events: string[] = []
  const runId = newRecordId()
  const question = snapshot({ runId, workflowCursorRecordId: null, askedVia: 'live' })
  database
    .query('INSERT INTO session_seen(session_id,last_seen) VALUES (?,?)')
    .run('owner-session', new Date().toISOString())
  const store = recordQuestionStore({
    database,
    destinationSpaceId: newRecordId(),
    pushRun: async (id) => events.push(`push:${id}`),
    client: {
      writeQuestion: async () => {
        events.push('write')
        return { id: question.id, number: 1, revision: 1 }
      },
      readQuestions: async () => ({
        items: [{ id: question.id, run_session_id: 'owner-session' }],
      }),
    },
  })
  await store.write('ask', {
    requestId: newRecordId(),
    question,
    audit: { action: 'ask', actorSession: null, at: STAMP, reason: null },
  })
  expect(events).toEqual([`push:${runId}`, 'write'])
  expect(await store.read({ read: 'inbox' })).toEqual({
    items: [{ id: question.id, run_session_id: 'owner-session', session_recent: 1 }],
  })
  await expect(store.read({ read: 'rulings', changedAfter: 1 })).rejects.toThrow('DEV-2328')
  database.close()
})
