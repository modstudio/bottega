import { afterEach, beforeEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { RecordApiClient } from '../record/record-api-client.ts'
import type { QuestionIntent } from '../record/record-question-contract.ts'
import { questionWriteSchema } from '../record/record-question-contract.ts'
import { upsertWorkflowQuestion } from '../run/question-mutation.ts'
import {
  type QuestionRunPusher,
  registerQuestionRunPusher,
  resolveQuestionRunPusher,
} from './question-run-pusher.ts'
import { askQuestion, questionSnapshotFromRow } from './question-store-mutation.ts'

const ID = '00000000-0000-4000-8000-000000000001'
const PROJECT_ID = '00000000-0000-4000-8000-000000000002'
const PROJECT_SPACE_ID = '00000000-0000-4000-8000-000000000003'
const PERSONAL_SPACE_ID = '00000000-0000-4000-8000-000000000004'
const RUN_ID = '00000000-0000-4000-8000-000000000005'
const CURSOR_ID = '00000000-0000-4000-8000-000000000006'
const STAMP = '2026-11-16T20:09:29.002Z'
let previousRecordApiUrl: string | undefined
let previousQuestionRunPusher: QuestionRunPusher

beforeEach(() => {
  previousQuestionRunPusher = resolveQuestionRunPusher()
  previousRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  registerQuestionRunPusher(async () => undefined)
})

afterEach(() => {
  installRecordApiClient(null)
  registerQuestionRunPusher(previousQuestionRunPusher)
  if (previousRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = previousRecordApiUrl
})

function seedProject(database: ReturnType<typeof migratedTestDatabase>): void {
  database
    .query('INSERT INTO project(record_id,name,path,stack,settings) VALUES (?,?,?,?,?)')
    .run(PROJECT_ID, 'question-mutation-fixture', '/fixture', 'bun', '{"space":"fixture"}')
}

function recordClient(
  writtenSpaces: string[],
  options: {
    questions?: Record<string, unknown>[]
    intents?: QuestionIntent[]
    closedAts?: (string | null)[]
  } = {},
): RecordApiClient {
  const client = createMemoryRecordApiClient({ questions: options.questions })
  return {
    ...client,
    whoami: async () => ({
      user: { id: newRecordId() },
      activeSpaceId: PROJECT_SPACE_ID,
      personalSpaceId: PERSONAL_SPACE_ID,
      memberships: [
        {
          space_id: PROJECT_SPACE_ID,
          name: 'Fixture',
          slug: 'fixture',
          permission: 'write',
        },
      ],
    }),
    readQuestions: async (input, destination) => {
      if (!options.questions || destination) return { items: [] }
      const result = await client.readQuestions!(input)
      return {
        ...result,
        items: result.items.map((question) => ({
          ...question,
          space_id: PERSONAL_SPACE_ID,
        })),
      }
    },
    writeQuestion: async (intent, input, destination) => {
      options.intents?.push(intent)
      options.closedAts?.push(input.question.closedAt)
      writtenSpaces.push(destination.destinationSpaceId)
      return client.writeQuestion!(intent, input, destination)
    },
  } as RecordApiClient
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    record_id: ID,
    number: 1,
    run_record_id: null,
    workflow_key: null,
    workflow_task_record_id: null,
    workflow_cursor_record_id: null,
    project_record_id: null,
    machine_id: ID,
    revision: 1,
    asked_at: '2026-11-16 20:09:29.002345+00',
    question: 'Proceed?',
    options: null,
    recommendation: null,
    why: null,
    asked_via: null,
    kind: null,
    typed_options: null,
    criteria: null,
    levels: null,
    answer: null,
    answer_value: null,
    answer_basis: null,
    answered_at: '2026-11-16 15:09:29.002345-05',
    answered_by: null,
    answered_by_name: null,
    answered_by_kind: null,
    answerer_kind: null,
    answer_channel: null,
    jev_pick: null,
    jev_confidence: null,
    jev_probabilities: null,
    jev_model: null,
    jev_input_tokens: null,
    jev_error: null,
    jev_agreed: null,
    jev_question_version: null,
    jev_fits: null,
    jev_order_flipped: null,
    awaiting_operator_at: null,
    relayed_by: null,
    overturned_at: null,
    overturned_by: null,
    overturned_by_name: null,
    overturn_reason: null,
    replacement: null,
    filed_as: null,
    filed_ref: null,
    filed_record_id: null,
    filed_label: null,
    filed_at: null,
    closed_at: null,
    close_reason: null,
    withheld_fields: [],
    created_at: '2026-11-16 20:09:29.002345+00',
    updated_at: '2026-11-16 20:09:29.002345+00',
    ...overrides,
  }
}

test('question snapshots normalize Postgres and Date timestamps to strict ISO instants', () => {
  const postgres = questionSnapshotFromRow(row())
  expect(questionWriteSchema.shape.question.safeParse(postgres).success).toBe(true)
  expect(postgres.askedAt).toBe('2026-11-16T20:09:29.002Z')
  expect(postgres.answeredAt).toBe(postgres.askedAt)

  const instant = new Date('2026-11-16T20:09:29.002Z')
  const dates = questionSnapshotFromRow(
    row({
      asked_at: instant,
      answered_at: instant,
      awaiting_operator_at: instant,
      overturned_at: instant,
      filed_at: instant,
      closed_at: instant,
      created_at: instant,
      updated_at: instant,
    }),
  )
  expect(questionWriteSchema.shape.question.safeParse(dates).success).toBe(true)
  expect([
    dates.askedAt,
    dates.answeredAt,
    dates.awaitingOperatorAt,
    dates.overturnedAt,
    dates.filedAt,
    dates.closedAt,
    dates.createdAt,
    dates.updatedAt,
  ]).toEqual(Array(8).fill(instant.toISOString()))
})

test('question snapshot timestamp failures name the field', () => {
  expect(() => questionSnapshotFromRow(row({ asked_at: new Date(Number.NaN) }))).toThrow('askedAt')
})

test("a run-bound ask resolves the run's project destination", async () => {
  const database = migratedTestDatabase()
  seedProject(database)
  database.exec('PRAGMA foreign_keys=OFF')
  database
    .query(`INSERT INTO run
      (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
      VALUES (?,1,?,'codex','implement','sha',1,'prompt','running',?)`)
    .run(RUN_ID, STAMP, PROJECT_ID)
  const writtenSpaces: string[] = []
  installRecordApiClient(recordClient(writtenSpaces))

  await askQuestion(database, {
    runId: RUN_ID,
    askedAt: STAMP,
    question: 'Proceed?',
  })

  expect(writtenSpaces).toEqual([PROJECT_SPACE_ID])
  database.close()
})

test('a cursor-bound ask without a project is refused without writing', async () => {
  const database = migratedTestDatabase()
  const writtenSpaces: string[] = []
  installRecordApiClient(recordClient(writtenSpaces))

  await expect(
    upsertWorkflowQuestion(
      {
        cursorId: CURSOR_ID,
        projectId: null,
        workflowKey: 'DEV-2373',
        workflowTaskRecordId: null,
        cursorOrdinal: 0,
        stepSlug: 'implement',
        question: 'Proceed?',
        at: STAMP,
      },
      database,
    ),
  ).rejects.toThrow(
    `ask for workflow cursor ${CURSOR_ID} carries no project; pass its project, then retry`,
  )

  expect(writtenSpaces).toEqual([])
  database.close()
})

test('a run-bound ask without a registered project is refused without writing', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  database
    .query(`INSERT INTO run
      (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id,probe)
      VALUES (?,1,?,'codex','implement','sha',1,'prompt','running',NULL,1)`)
    .run(RUN_ID, STAMP)
  const writtenSpaces: string[] = []
  installRecordApiClient(recordClient(writtenSpaces))

  await expect(
    askQuestion(database, { runId: RUN_ID, askedAt: STAMP, question: 'Proceed?' }),
  ).rejects.toThrow(
    `run ${RUN_ID} carries no project, so its question has no record space; start the run from a registered project checkout, then retry`,
  )
  expect(writtenSpaces).toEqual([])
  database.close()
})

test('a run-bound ask whose run is absent is refused without writing', async () => {
  const database = migratedTestDatabase()
  const writtenSpaces: string[] = []
  installRecordApiClient(recordClient(writtenSpaces))

  await expect(
    askQuestion(database, { runId: RUN_ID, askedAt: STAMP, question: 'Proceed?' }),
  ).rejects.toThrow(
    `run ${RUN_ID} is not in this machine's store, so its question has no record space; rerun the command from the machine that started the run`,
  )
  expect(writtenSpaces).toEqual([])
  database.close()
})

test("a projectless open cursor question is closed and re-asked in the project's space", async () => {
  const database = migratedTestDatabase()
  seedProject(database)
  const openQuestion = row({
    record_id: ID,
    question_record_id: ID,
    workflow_cursor_record_id: CURSOR_ID,
    workflow_key: 'DEV-2373',
    project_record_id: null,
    awaiting_operator_at: STAMP,
    closed_at: null,
    answered_at: null,
    workflow_step_ordinal: 1,
    workflow_step_slug: 'implement',
  })
  const writtenSpaces: string[] = []
  const intents: QuestionIntent[] = []
  const closedAts: (string | null)[] = []
  installRecordApiClient(
    recordClient(writtenSpaces, { questions: [openQuestion], intents, closedAts }),
  )

  const inserted = await upsertWorkflowQuestion(
    {
      cursorId: CURSOR_ID,
      projectId: PROJECT_ID,
      workflowKey: 'DEV-2373',
      workflowTaskRecordId: null,
      cursorOrdinal: 0,
      stepSlug: 'implement',
      question: 'Proceed?',
      at: STAMP,
    },
    database,
  )

  expect(intents).toEqual(['close', 'ask'])
  expect(closedAts).toEqual([STAMP, null])
  expect(writtenSpaces).toEqual([PERSONAL_SPACE_ID, PROJECT_SPACE_ID])
  expect(inserted.recordId).not.toBe(ID)
  database.close()
})

test("an open question still links when its project's space is undeclared", async () => {
  const database = migratedTestDatabase()
  database
    .query('INSERT INTO project(record_id,name,path,stack,settings) VALUES (?,?,?,?,?)')
    .run(PROJECT_ID, 'question-mutation-fixture', '/fixture', 'bun', '{}')
  const openQuestion = row({
    record_id: ID,
    question_record_id: ID,
    workflow_cursor_record_id: CURSOR_ID,
    workflow_key: 'DEV-2515',
    project_record_id: PROJECT_ID,
    awaiting_operator_at: STAMP,
    closed_at: null,
    answered_at: null,
    workflow_step_ordinal: 1,
    workflow_step_slug: 'implement',
  })
  const writtenSpaces: string[] = []
  const intents: QuestionIntent[] = []
  installRecordApiClient(recordClient(writtenSpaces, { questions: [openQuestion], intents }))

  const linked = await upsertWorkflowQuestion(
    {
      cursorId: CURSOR_ID,
      projectId: PROJECT_ID,
      workflowKey: 'DEV-2515',
      workflowTaskRecordId: null,
      cursorOrdinal: 0,
      stepSlug: 'implement',
      question: 'Proceed?',
      at: STAMP,
    },
    database,
  )

  expect(linked).toEqual({ recordId: ID, number: 1 })
  expect(intents).toEqual(['link'])
  expect(writtenSpaces).toEqual([PERSONAL_SPACE_ID])
  database.close()
})
