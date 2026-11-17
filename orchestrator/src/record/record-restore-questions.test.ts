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
const PERSONAL_SPACE = '01990000-0000-7000-8000-000000002385'
const PROJECT_SPACE = '01990000-0000-7000-8000-000000002386'
const PROJECT = '01990000-0000-7000-8000-000000002387'
const MACHINE = '01990000-0000-7000-8000-000000002381'
const QUESTION = '01990000-0000-7000-8000-000000002382'

function snapshot(
  revision: number,
  number = 6713,
  projectId: string | null = null,
): QuestionWriteBody['question'] {
  return {
    id: QUESTION,
    number,
    runId: null,
    workflowKey: null,
    workflowTaskId: null,
    workflowCursorRecordId: null,
    projectId,
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

function payload(
  revision: number,
  id = QUESTION,
  number = 6713,
  projectId: string | null = null,
): string {
  return JSON.stringify({
    ...snapshot(revision, number, projectId),
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
  database.exec(`CREATE TABLE project (
    record_id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, stack TEXT,
    canon INTEGER NOT NULL DEFAULT 0, settings TEXT, retired_at TEXT
  )`)
  database
    .query('INSERT INTO project (record_id,name,path,settings) VALUES (?,?,?,?)')
    .run(PROJECT, 'registered', '/w/registered', JSON.stringify({ space: 'registered-space' }))
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
      client: {
        whoami: async () => identity(),
        writeQuestion: async () => Promise.reject(new Error('must not send')),
      },
      log: (line) => lines.push(line),
      setExitCode: () => {},
    },
  )
  expect(lines[0]).toBe(`6713\t${QUESTION}\twould restore to ${PERSONAL_SPACE}`)
  expect(database.query('SELECT * FROM outbox').get()).toEqual(before)
})

function identity() {
  return {
    user: { id: '01990000-0000-7000-8000-000000002388' },
    activeSpaceId: SPACE,
    personalSpaceId: PERSONAL_SPACE,
    memberships: [
      {
        space_id: PROJECT_SPACE,
        slug: 'registered-space',
        permission: 'write',
      },
    ],
  }
}

test('restore routes project questions to the declared space and unscoped questions to personal', async () => {
  using database = outboxDatabase()
  const projectQuestion = '01990000-0000-7000-8000-000000002389'
  database
    .query("INSERT INTO outbox (id,kind,row_id,payload,retired_at) VALUES (78,'question',?,?,?)")
    .run(projectQuestion, payload(1, projectQuestion, 6714, PROJECT), STAMP)
  const writes: Array<{ id: string; destination: string }> = []
  await restoreQuestionsCommand(
    { dryRun: false },
    {
      database,
      client: {
        whoami: async () => identity(),
        writeQuestion: async (_intent, body, destination) => {
          writes.push({ id: body.question.id, destination: destination.destinationSpaceId })
          return { id: body.question.id, number: body.question.number!, revision: 1, applied: true }
        },
      },
      log: () => {},
      setExitCode: () => {},
    },
  )
  expect(writes).toEqual([
    { id: QUESTION, destination: PERSONAL_SPACE },
    { id: projectQuestion, destination: PROJECT_SPACE },
  ])
})

test('restore refuses unregistered and undeclared projects without sending', async () => {
  using database = outboxDatabase()
  const undeclaredProject = '01990000-0000-7000-8000-000000002390'
  const unregisteredProject = '01990000-0000-7000-8000-000000002391'
  const undeclaredQuestion = '01990000-0000-7000-8000-000000002392'
  const unregisteredQuestion = '01990000-0000-7000-8000-000000002393'
  database
    .query('INSERT INTO project (record_id,name,path,settings) VALUES (?,?,?,?)')
    .run(undeclaredProject, 'undeclared', '/w/undeclared', '{}')
  database
    .query("INSERT INTO outbox (id,kind,row_id,payload,retired_at) VALUES (78,'question',?,?,?)")
    .run(undeclaredQuestion, payload(1, undeclaredQuestion, 6714, undeclaredProject), STAMP)
  database
    .query("INSERT INTO outbox (id,kind,row_id,payload,retired_at) VALUES (79,'question',?,?,?)")
    .run(unregisteredQuestion, payload(1, unregisteredQuestion, 6715, unregisteredProject), STAMP)
  const lines: string[] = []
  const writes: string[] = []
  await restoreQuestionsCommand(
    { dryRun: false },
    {
      database,
      client: {
        whoami: async () => identity(),
        writeQuestion: async (_intent, body) => {
          writes.push(body.question.id)
          return { id: body.question.id, number: body.question.number!, revision: 1, applied: true }
        },
      },
      log: (line) => lines.push(line),
      setExitCode: () => {},
    },
  )
  expect(writes).toEqual([QUESTION])
  expect(lines.find((line) => line.includes(undeclaredQuestion))).toContain(
    'project undeclared has no declared record space',
  )
  expect(lines.find((line) => line.includes(unregisteredQuestion))).toContain(
    `project ${unregisteredProject} is not registered; register it, then retry`,
  )
  expect(lines.at(-1)).toBe('1 restored, 0 unchanged, 2 refused, 0 failed')
})

test('restore reports a replayed write as unchanged', async () => {
  using database = outboxDatabase()
  const lines: string[] = []
  await restoreQuestionsCommand(
    { dryRun: false },
    {
      database,
      client: {
        whoami: async () => identity(),
        writeQuestion: async (_intent, body) => ({
          id: body.question.id,
          number: body.question.number!,
          revision: body.question.revision,
          applied: true,
          replayed: true,
        }),
      },
      log: (line) => lines.push(line),
      setExitCode: () => {},
    },
  )
  expect(lines).toContain(`6713\t${QUESTION}\tunchanged`)
  expect(lines.at(-1)).toBe('0 restored, 1 unchanged, 0 refused, 0 failed')
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
        whoami: async () => identity(),
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
    destination: PERSONAL_SPACE,
    body: { question: { id: QUESTION, number: 6713, revision: 2, answer: 'Yes' } },
  })
  expect(lines).toContain(`6713\t${QUESTION}\trefused: number 6713 is held by another question`)
  expect(lines.at(-1)).toBe('0 restored, 0 unchanged, 2 refused, 0 failed')
  expect(exitCodes).toEqual([1])
})
