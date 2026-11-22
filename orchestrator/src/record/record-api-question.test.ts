import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
  encodeRecordChangeCursor,
  type RecordChangeCursor,
} from '../../../shared/record/record-changes.ts'
import {
  createRecordContractFixture,
  RECORD_CONTRACT_SPACE_A,
  RECORD_CONTRACT_SPACE_B,
  RECORD_CONTRACT_USER,
} from '../../test/fixtures/record-contract.ts'
import {
  type RecordQuestionRouteDeps,
  registerRecordQuestionRoutes,
} from './record-api-question.ts'
import type { RecordIdentity } from './record-auth.ts'
import { RECORD_KEYED_NOT_VISIBLE_CODE } from './record-keyed-read.ts'
import {
  type QuestionIntent,
  type QuestionWriteBody,
  UnboundedQuestionRulingsError,
} from './record-question-contract.ts'
import { readRecordQuestions } from './record-question-read.ts'

const tenant = {
  url: 'postgres://record.test',
  userId: '01990000-0000-7000-8000-000000002001',
  spaceId: '01990000-0000-7000-8000-000000002002',
  spaceIds: ['01990000-0000-7000-8000-000000002002'],
}

function app(deps: RecordQuestionRouteDeps, destinationSpaceId?: string, uuidKeyedRead = false) {
  const api = new Hono<{
    Variables: { identity: RecordIdentity; destinationSpaceId?: string }
  }>()
  if (destinationSpaceId)
    api.use('*', async (context, next) => {
      context.set('destinationSpaceId', destinationSpaceId)
      await next()
    })
  registerRecordQuestionRoutes(api, deps, {
    scope: () => ({ ...tenant, ...(uuidKeyedRead ? { uuidKeyedRead: true as const } : {}) }),
    noSpace: () => new Response(null, { status: 409 }),
  })
  return api
}

test('hosted rulings decode opaque cursors and malformed cursors give a fresh-cursor remedy', async () => {
  const cursor = { xid: 12n, seq: 34n }
  let received: RecordChangeCursor | undefined
  const api = app({
    readQuestions: async (input) => {
      if (
        input.read === 'rulings' &&
        input.changedAfter &&
        !('questionNumber' in input.changedAfter)
      )
        received = input.changedAfter
      return { items: [], cursor: encodeRecordChangeCursor(cursor), more: false, reset: false }
    },
  })
  const response = await api.request(
    `/v1/questions?read=rulings&changedAfter=${encodeRecordChangeCursor(cursor)}`,
  )
  expect(response.status).toBe(200)
  expect(received).toEqual(cursor)

  let receivedPage: unknown
  const pageApi = app({
    readQuestions: async (input) => {
      if (input.read === 'rulings') receivedPage = input.changedAfter
      return { items: [] }
    },
  })
  const encoded = encodeRecordChangeCursor(cursor)
  expect(
    (await pageApi.request(`/v1/questions?read=rulings&changedAfter=page:7:${encoded}`)).status,
  ).toBe(200)
  expect(receivedPage).toEqual({ questionNumber: 7, changeHead: cursor })

  const malformed = await api.request('/v1/questions?read=rulings&changedAfter=bad')
  expect(malformed.status).toBe(422)
  expect(await malformed.json()).toEqual({
    error: 'record change cursor is malformed',
    remedy: 'retry without changedAfter to get a fresh cursor',
  })
})

test('hosted rulings refuse combining a change cursor with a limit', async () => {
  const cursor = encodeRecordChangeCursor({ xid: 12n, seq: 34n })
  const response = await app({ readQuestions: async () => ({ items: [] }) }).request(
    `/v1/questions?read=rulings&changedAfter=${cursor}&limit=1`,
  )
  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({
    error: 'limit cannot be combined with changedAfter',
    remedy: 'drop limit; follow more to page',
  })
})

test('hosted rulings refuse an unbounded history read and serve every bounded form', async () => {
  const reads: string[] = []
  const api = app({
    readQuestions: async (input) => {
      if (input.read === 'rulings')
        reads.push(
          input.since !== undefined
            ? 'since'
            : input.limit !== undefined
              ? 'limit'
              : input.changedAfter !== undefined
                ? 'changedAfter'
                : 'unbounded',
        )
      if (
        input.read === 'rulings' &&
        input.since === undefined &&
        input.limit === undefined &&
        input.changedAfter === undefined
      )
        throw new UnboundedQuestionRulingsError()
      return { items: [], cursor: encodeRecordChangeCursor({ xid: 1n, seq: 1n }), more: false }
    },
  })
  const refused = await api.request('/v1/questions?read=rulings')
  expect(refused.status).toBe(422)
  expect(await refused.json()).toEqual({
    error: 'unbounded question ruling history reads are refused',
    remedy:
      'use by-id, by-number, for-run, for-runs, for-session, open-for-cursors, open-for-tasks, or unlinked-workflow for a targeted read; otherwise page rulings with limit and changedAfter',
  })
  expect(
    (await api.request('/v1/questions?read=rulings&since=2026-11-15T12%3A00%3A00.000Z')).status,
  ).toBe(200)
  expect((await api.request('/v1/questions?read=rulings&limit=1')).status).toBe(200)
  const cursor = encodeRecordChangeCursor({ xid: 1n, seq: 1n })
  expect((await api.request(`/v1/questions?read=rulings&changedAfter=${cursor}`)).status).toBe(200)
  expect(reads).toEqual(['unbounded', 'since', 'limit', 'changedAfter'])
})

test('hosted read service refuses unbounded ruling materialization', async () => {
  expect(readRecordQuestions({ ...tenant, read: 'rulings', kind: 'all' })).rejects.toBeInstanceOf(
    UnboundedQuestionRulingsError,
  )
})

test('hosted question reads other than rulings still refuse changedAfter', async () => {
  const response = await app({ readQuestions: async () => ({ items: [] }) }).request(
    '/v1/questions?read=waiting&changedAfter=opaque',
  )
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({ remedy: expect.stringContaining('rulings read') })
})

test('a destinationless question by-id miss returns the membership-safe refusal', async () => {
  const response = await app(
    { readQuestions: async () => ({ items: [] }) },
    undefined,
    true,
  ).request('/v1/questions?read=by-id&ids=00000000-0000-4000-8000-000000000001')
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({
    error: 'not visible in your record spaces (1 memberships)',
    remedy:
      'the row is in a space you are not a member of, or it does not exist; join its space or check the id',
    code: RECORD_KEYED_NOT_VISIBLE_CODE,
  })
})

test('a destinationless question for-run miss keeps the empty-items response', async () => {
  const response = await app(
    { readQuestions: async () => ({ items: [] }) },
    undefined,
    true,
  ).request('/v1/questions?read=for-run&runId=00000000-0000-4000-8000-000000000001')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ items: [] })
})

test('a question by-id miss with a named destination keeps the empty-items response', async () => {
  const response = await app(
    { readQuestions: async () => ({ items: [] }) },
    tenant.spaceId,
  ).request('/v1/questions?read=by-id&ids=00000000-0000-4000-8000-000000000001')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ items: [] })
})

test('invalid direct question writes name the failing body path', async () => {
  const response = await app({ writeQuestion: async () => ({ applied: true }) }).request(
    '/v1/questions/answer',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: '00000000-0000-4000-8000-000000000001',
        question: {
          id: '00000000-0000-4000-8000-000000000002',
          runId: null,
          workflowKey: null,
          workflowTaskId: null,
          workflowCursorRecordId: null,
          projectId: null,
          machineId: '00000000-0000-4000-8000-000000000003',
          revision: 1,
          askedAt: 'not-a-timestamp',
          question: 'Proceed?',
          options: null,
          recommendation: null,
          why: null,
          askedVia: null,
          kind: null,
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
          createdAt: '2026-11-16T20:09:29.002Z',
          updatedAt: '2026-11-16T20:09:29.002Z',
        },
        audit: {
          action: 'answer',
          actorSession: null,
          at: '2026-11-16T20:09:29.002Z',
          reason: null,
        },
      }),
    },
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: expect.stringContaining('question.askedAt:'),
  })
})

test('an unknown direct question write intent is named in the refusal', async () => {
  const response = await app({ writeQuestion: async () => ({ applied: true }) }).request(
    '/v1/questions/answerr',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: expect.stringContaining('(intent):') })
})

const MUTATING_INTENTS = [
  'answer',
  'close',
  'file',
  'link',
  'overturn',
  'relay',
  'abandon',
] as const satisfies readonly QuestionIntent[]
const CONTRACT_MACHINE = '01990000-0000-7000-8000-000000025000'
const OUTSIDE_PROJECT = '01990000-0000-7000-8000-000000025001'
const CONTRACT_STAMP = '2026-11-20T12:00:00.000Z'

function contractId(sequence: number): string {
  return `01990000-0000-7000-8000-${String(sequence).padStart(12, '0')}`
}

function mutationBody(
  intent: (typeof MUTATING_INTENTS)[number],
  questionId: string,
  requestId: string,
  number: number,
): QuestionWriteBody {
  const question: QuestionWriteBody['question'] = {
    id: questionId,
    number,
    runId: null,
    workflowKey: null,
    workflowTaskId: null,
    workflowCursorRecordId: null,
    projectId: OUTSIDE_PROJECT,
    machineId: CONTRACT_MACHINE,
    revision: 2,
    askedAt: CONTRACT_STAMP,
    question: 'Which way?',
    options: null,
    recommendation: null,
    why: null,
    askedVia: 'contract-test',
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
    createdAt: CONTRACT_STAMP,
    updatedAt: CONTRACT_STAMP,
  }
  if (intent === 'answer' || intent === 'abandon') {
    question.answer = intent === 'answer' ? 'Proceed' : '(abandoned)'
    question.answerBasis = intent === 'answer' ? 'Contract ruling' : 'Question abandoned'
    question.answeredAt = CONTRACT_STAMP
    question.answeredBy = 'contract-test'
    question.answererKind = 'agent'
    question.answerChannel = 'cli'
  } else if (intent === 'close') {
    question.closedAt = CONTRACT_STAMP
    question.closeReason = 'Superseded'
  } else if (intent === 'file') {
    question.filedAs = 'issue'
    question.filedRef = 'DEV-2515'
    question.filedLabel = 'Question project identity'
    question.filedAt = CONTRACT_STAMP
  } else if (intent === 'link') {
    question.workflowKey = 'contract-flow'
    question.question = 'Which linked way?'
  } else if (intent === 'overturn') {
    question.overturnedAt = CONTRACT_STAMP
    question.overturnedBy = 'contract-test'
    question.overturnReason = 'Earlier ruling was incomplete'
    question.replacement = 'Use the replacement'
  } else {
    question.awaitingOperatorAt = CONTRACT_STAMP
    question.relayedBy = 'contract-test'
  }
  return {
    requestId,
    question,
    audit: { action: intent, actorSession: 'contract-test', at: CONTRACT_STAMP, reason: null },
  }
}

test('question routes forward validated free text to the masked writer', async () => {
  const secret = 'ghp_123456789012345678901234567890123456'
  const generic = 'a key=value line with bearer prose and VGhpcyBpcyBhIGdlbmVyaWMgcHJvc2Ugc2FtcGxl'
  const body = mutationBody('answer', contractId(29001), contractId(29002), 1)
  body.question.answer = `${generic} quoted ${secret}`
  let stored = ''
  const response = await app({
    writeQuestion: async (_intent, input) => {
      stored = input.question.answer ?? ''
      return { id: input.question.id, number: 1, revision: 1, applied: true, replayed: false }
    },
  }).request('/v1/questions/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  expect(stored).toBe(`${generic} quoted ${secret}`)
})

test('existing question mutations keep the stored project while asks still resolve payload projects', async () => {
  const fixture = await createRecordContractFixture()
  const seeded = MUTATING_INTENTS.flatMap((intent, intentIndex) =>
    ([OUTSIDE_PROJECT, null] as const).map((storedProject, projectIndex) => ({
      intent,
      id: contractId(25_100 + intentIndex * 2 + projectIndex),
      number: intentIndex * 2 + projectIndex + 1,
      storedProject,
    })),
  )
  try {
    await fixture.database.exec(`
      RESET ROLE;
      INSERT INTO machine (id,user_id,name,registered_at,last_seen)
      VALUES ('${CONTRACT_MACHINE}','${RECORD_CONTRACT_USER}','Question mutation machine',now(),now());
      INSERT INTO project (id,space_id,name,key_prefixes,created_at)
      VALUES ('${OUTSIDE_PROJECT}','${RECORD_CONTRACT_SPACE_B}','outside-question-project',ARRAY['OUT'],now());
      INSERT INTO question
        (id,space_id,project_id,machine_id,number,revision,withheld_fields,asked_at,question,created_at,updated_at)
      VALUES
        ${seeded
          .map(
            (row) =>
              `('${row.id}','${RECORD_CONTRACT_SPACE_A}',${row.storedProject ? `'${row.storedProject}'` : 'NULL'},` +
              `'${CONTRACT_MACHINE}',${row.number},1,'[]','${CONTRACT_STAMP}','Which way?',` +
              `'${CONTRACT_STAMP}','${CONTRACT_STAMP}')`,
          )
          .join(',\n')};
      SET ROLE record_actor;
    `)

    const mutationResults: Array<{
      intent: string
      responses: Array<{ status: number; applied: unknown }>
    }> = []
    for (const [intentIndex, intent] of MUTATING_INTENTS.entries()) {
      const pair = seeded.filter((row) => row.intent === intent)
      const responses = await Promise.all(
        pair.map((row, projectIndex) =>
          fixture.app.request(`/v1/questions/${intent}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-record-space': RECORD_CONTRACT_SPACE_A,
            },
            body: JSON.stringify(
              mutationBody(
                intent,
                row.id,
                contractId(25_200 + intentIndex * 2 + projectIndex),
                row.number,
              ),
            ),
          }),
        ),
      )
      const bodies = await Promise.all(responses.map((response) => response.json()))
      mutationResults.push({
        intent,
        responses: responses.map((response, index) => ({
          status: response.status,
          applied: (bodies[index] as { applied?: unknown }).applied,
        })),
      })
    }
    expect(mutationResults).toEqual(
      MUTATING_INTENTS.map((intent) => ({
        intent,
        responses: [
          { status: 200, applied: true },
          { status: 200, applied: true },
        ],
      })),
    )

    const projects = await fixture.database.query<{ id: string; project_id: string | null }>(`
      SELECT id::text,project_id::text FROM question
      WHERE id IN (${seeded.map((row) => `'${row.id}'`).join(',')})
      ORDER BY number
    `)
    expect(projects.rows).toEqual(
      seeded.map((row) => ({ id: row.id, project_id: row.storedProject })),
    )

    const askBody = mutationBody('link', contractId(25_300), contractId(25_301), seeded.length + 1)
    askBody.question.workflowKey = null
    askBody.audit.action = 'ask'
    const refusedAsk = await fixture.app.request('/v1/questions/ask', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-record-space': RECORD_CONTRACT_SPACE_A,
      },
      body: JSON.stringify(askBody),
    })
    expect(refusedAsk.status).toBe(422)
    expect(await refusedAsk.json()).toMatchObject({
      error: expect.stringContaining(
        `record project ${OUTSIDE_PROJECT} is absent from request space ${RECORD_CONTRACT_SPACE_A}`,
      ),
    })
  } finally {
    await fixture.close()
  }
})
