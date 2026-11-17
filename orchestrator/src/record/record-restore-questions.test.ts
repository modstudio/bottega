import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { RecordApiRequestError } from './record-api-client-response.ts'
import type { QuestionWriteBody } from './record-question-contract.ts'
import {
  newestRetiredQuestionPayloads,
  restoreQuestionRefusalReason,
  restoreQuestionRequestId,
  restoreQuestionsCommand,
} from './record-restore-questions.ts'

const STAMP = '2026-11-16T12:00:00.000Z'
const SPACE = '01990000-0000-7000-8000-000000002380'
const MACHINE = '01990000-0000-7000-8000-000000002381'
const QUESTION = '01990000-0000-7000-8000-000000002382'

function snapshot(revision: number, number = 6713): QuestionWriteBody['question'] {
  return {
    id: QUESTION,
    number,
    runId: null,
    workflowKey: null,
    workflowTaskId: null,
    workflowCursorRecordId: null,
    projectId: null,
    machineId: MACHINE,
    revision,
    askedAt: STAMP,
    question: 'Restore this?',
    options: null,
    recommendation: null,
    why: null,
    askedVia: 'live',
    kind: null,
    typedOptions: null,
    criteria: null,
    levels: null,
    answer: revision > 1 ? 'Yes' : null,
    answerValue: null,
    answerBasis: null,
    answeredAt: revision > 1 ? STAMP : null,
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
  }
}

function payload(revision: number, id = QUESTION): string {
  return JSON.stringify({
    ...snapshot(revision),
    id,
    spaceId: SPACE,
    audits: [{ action: 'rule', actorSession: 'architect', at: STAMP, reason: 'Yes' }],
  })
}

test('retired question selection keeps the highest revision for each question id', () => {
  const second = '01990000-0000-7000-8000-000000002383'
  const selection = newestRetiredQuestionPayloads([
    { id: 10, rowId: QUESTION, payload: payload(1) },
    { id: 11, rowId: second, payload: payload(1, second) },
    { id: 12, rowId: QUESTION, payload: payload(3) },
    { id: 13, rowId: QUESTION, payload: payload(2) },
  ])
  expect(selection.rejected).toEqual([])
  expect(
    selection.candidates.map(({ id, revision, outboxId }) => ({ id, revision, outboxId })),
  ).toEqual([
    { id: second, revision: 1, outboxId: 11 },
    { id: QUESTION, revision: 3, outboxId: 12 },
  ])
})

test('restore request ids are deterministic UUIDs derived from the outbox row', () => {
  expect(restoreQuestionRequestId(77)).toBe(restoreQuestionRequestId(77))
  expect(restoreQuestionRequestId(77)).not.toBe(restoreQuestionRequestId(78))
})

test('restore refusal reasons distinguish hosted refusals from failures', () => {
  expect(
    restoreQuestionRefusalReason(Object.assign(new Error('number is held'), { status: 409 })),
  ).toBe('number is held')
  expect(
    restoreQuestionRefusalReason(new RecordApiRequestError('sign in, then retry', 'refused')),
  ).toBe('sign in, then retry')
  expect(restoreQuestionRefusalReason(new Error('network failed'))).toBeNull()
})

function outboxDatabase(): Database {
  const database = new Database(':memory:')
  database.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL, row_id TEXT NOT NULL, payload TEXT NOT NULL,
    synced_at TEXT, retired_at TEXT
  )`)
  database
    .query("INSERT INTO outbox (id,kind,row_id,payload,retired_at) VALUES (77,'question',?,?,?)")
    .run(QUESTION, payload(2), STAMP)
  return database
}

test('dry-run lists retired questions without calling the record or changing SQLite', async () => {
  using database = outboxDatabase()
  const before = database.query('SELECT * FROM outbox').get()
  const lines: string[] = []
  await restoreQuestionsCommand(
    { dryRun: true },
    {
      database,
      client: { writeQuestion: async () => Promise.reject(new Error('must not send')) },
      log: (line) => lines.push(line),
      setExitCode: () => {},
    },
  )
  expect(lines[0]).toBe(`6713\t${QUESTION}\twould restore`)
  expect(database.query('SELECT * FROM outbox').get()).toEqual(before)
})

test('restore reports malformed and hosted refusals and exits non-zero', async () => {
  using database = outboxDatabase()
  database
    .query("INSERT INTO outbox (id,kind,row_id,payload,retired_at) VALUES (78,'question',?,?,?)")
    .run('01990000-0000-7000-8000-000000002384', '{', STAMP)
  const writes: Array<{ intent: string; body: QuestionWriteBody; destination: string }> = []
  const lines: string[] = []
  const exitCodes: number[] = []
  await restoreQuestionsCommand(
    { dryRun: false },
    {
      database,
      client: {
        writeQuestion: async (intent, body, destination) => {
          writes.push({ intent, body, destination: destination.destinationSpaceId })
          throw Object.assign(new Error('number 6713 is held by another question'), { status: 409 })
        },
      },
      log: (line) => lines.push(line),
      setExitCode: (code) => exitCodes.push(code),
    },
  )
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({
    intent: 'restore',
    destination: SPACE,
    body: { question: { id: QUESTION, number: 6713, revision: 2, answer: 'Yes' } },
  })
  expect(lines).toContain(`6713\t${QUESTION}\trefused: number 6713 is held by another question`)
  expect(lines.at(-1)).toBe('0 restored, 0 unchanged, 2 refused, 0 failed')
  expect(exitCodes).toEqual([1])
})
