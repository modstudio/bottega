import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { createHostedRecordFixture, pgliteSql } from '../../test/fixtures/hosted-record.ts'
import type { QuestionImportBody, QuestionWriteBody } from './record-question-contract.ts'
import { writeRecordQuestionTransaction } from './record-question-write.ts'
import { writeRecordTaskFlowTransaction } from './record-task-flow-write.ts'
import type { TaskFlowIntentBody } from './record-task-flow-write-contract.ts'

const SPACE = '01990000-0000-7000-8000-000000002500'
const USER = '01990000-0000-7000-8000-000000002502'
const PROJECT = '01990000-0000-7000-8000-000000002503'
const MACHINE = '01990000-0000-7000-8000-000000002504'
const WORKFLOW = '01990000-0000-7000-8000-000000002505'
const WORKFLOW_VERSION = '01990000-0000-7000-8000-000000002506'
const CATALOGUE = '01990000-0000-7000-8000-000000002507'
const CATALOGUE_VERSION = '01990000-0000-7000-8000-000000002508'
const FLOW = '01990000-0000-7000-8000-000000002509'
const STAGE_ONE = '01990000-0000-7000-8000-000000002510'
const STAGE_TWO = '01990000-0000-7000-8000-000000002511'
const STAGE_LIVE = '01990000-0000-7000-8000-000000002512'
const QUESTION_ONE = '01990000-0000-7000-8000-000000002513'
const QUESTION_TWO = '01990000-0000-7000-8000-000000002514'
const QUESTION_LIVE = '01990000-0000-7000-8000-000000002515'
const REQUEST = '01990000-0000-7000-8000-000000002516'
const REQUEST_TWO = '01990000-0000-7000-8000-000000002517'
const REQUEST_LIVE = '01990000-0000-7000-8000-000000002518'
const AUDIT = '01990000-0000-7000-8000-000000002519'
const OBLIGATION = '01990000-0000-7000-8000-000000002520'
const TEXT = '01990000-0000-7000-8000-000000002521'
const COPY = '01990000-0000-7000-8000-000000002522'
const STAMP = '2025-04-03T02:01:00.000Z'
const FINISHED = '2025-04-04T03:02:00.000Z'

let postgres: PGlite
const principal = { url: 'pglite', userId: USER, spaceId: SPACE, spaceIds: [SPACE] }
const pgliteJsonb = (_sql: unknown, value: unknown) => ({
  sql: `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`,
})

beforeEach(async () => {
  postgres = await createHostedRecordFixture({ spaceId: SPACE, userId: USER })
  await postgres.exec(`
    RESET ROLE;
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES ('${PROJECT}','${SPACE}','imports',ARRAY['DEV'],now());
    INSERT INTO machine (id,user_id,name,registered_at,last_seen)
    VALUES ('${MACHINE}','${USER}','imports',now(),now());
    INSERT INTO workflow (id,space_id,slug,created_at,updated_at)
    VALUES ('${WORKFLOW}','${SPACE}','proof',now(),now());
    INSERT INTO workflow_version
      (id,space_id,workflow_id,n,status,definition,author,reason,created_at,updated_at)
    VALUES ('${WORKFLOW_VERSION}','${SPACE}','${WORKFLOW}',1,'production','{}','test','proof',now(),now());
    INSERT INTO step_catalogue (id,space_id,slug,created_at,updated_at)
    VALUES ('${CATALOGUE}','${SPACE}','proof',now(),now());
    INSERT INTO step_catalogue_version
      (id,space_id,catalogue_id,n,status,definition,author,reason,created_at,updated_at)
    VALUES ('${CATALOGUE_VERSION}','${SPACE}','${CATALOGUE}',1,'production','{}','test','proof',now(),now());
    SET ROLE record_actor;
  `)
})

afterEach(async () => {
  await postgres.close()
})

function stage(id: string, slug: string) {
  return {
    id,
    flowRecordId: FLOW,
    projectId: PROJECT,
    workflow: 'proof',
    mode: 'default',
    workflowKey: `DEV-${slug}`,
    instanceId: 'primary',
    sessionId: 'historical-session',
    workflowVersionId: WORKFLOW_VERSION,
    catalogueVersionId: CATALOGUE_VERSION,
    arguments: {},
    activeOrdinal: 1,
    activeSlug: slug,
    state: 'done' as const,
    closedStepNotes: [{ slug, note: 'finished' }],
    question: null,
    autonomy: 'guided',
    enforcement: 'strict',
    totalSteps: 2,
    openedMachineId: MACHINE,
    takenOverFromMachineId: null,
    lastAdvancedMachineId: MACHINE,
    createdAt: STAMP,
    updatedAt: FINISHED,
    revision: 4,
  }
}

function flowImport(): TaskFlowIntentBody<'import'> {
  return {
    requestId: REQUEST,
    flow: {
      id: FLOW,
      projectId: PROJECT,
      taskId: null,
      parentFlowRecordId: null,
      state: 'done',
      openStageRecordId: null,
      openingMachineId: MACHINE,
      updatedMachineId: MACHINE,
      createdAt: STAMP,
      updatedAt: FINISHED,
      revision: 7,
    },
    stages: [stage(STAGE_TWO, 'second'), stage(STAGE_ONE, 'first')],
    obligations: [
      {
        id: OBLIGATION,
        stageRecordId: STAGE_TWO,
        stepOrdinal: 1,
        stepSlug: 'second',
        floor: 'test',
        requirePullRequest: false,
        expectedExitCode: 0,
        expectedStatus: 'passed',
        floorDeferrable: false,
        reason: 'historical obligation',
        sessionId: 'historical-session',
        createdAt: STAMP,
        satisfiedAt: FINISHED,
        satisfiedStepOrdinal: 1,
        satisfiedStepSlug: 'second',
        satisfiedEvidence: [{ command: 'bun test', status: 'passed' }],
        abandonedAt: null,
        abandonedReason: null,
        operatorRuling: false,
      },
    ],
    texts: [
      {
        id: TEXT,
        stageRecordId: STAGE_TWO,
        stepOrdinal: 1,
        stepSlug: 'second',
        body: 'historical step text',
        createdAt: STAMP,
      },
    ],
    copies: [
      {
        id: COPY,
        workflowTextRecordId: TEXT,
        stageRecordId: STAGE_TWO,
        taskDocumentReference: 'DEV-2419/1',
        copiedAt: FINISHED,
      },
    ],
  }
}

function questionImport(id: string, requestId: string): QuestionImportBody {
  return {
    requestId,
    question: {
      id,
      number: 99,
      runId: null,
      workflowKey: null,
      workflowTaskId: null,
      workflowCursorRecordId: null,
      projectId: null,
      machineId: MACHINE,
      revision: 3,
      askedAt: STAMP,
      question: 'Historical question?',
      options: ['yes', 'no'],
      recommendation: 'yes',
      why: 'recorded reason',
      askedVia: 'workflow',
      kind: 'choice',
      typedOptions: null,
      criteria: null,
      levels: null,
      answer: 'yes',
      answerValue: 'yes',
      answerBasis: 'operator',
      answeredAt: FINISHED,
      answeredBy: 'operator',
      answeredByName: 'Operator',
      answeredByKind: 'operator',
      answererKind: 'operator',
      answerChannel: 'chat',
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
      relayedBy: 'session',
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
      closedAt: FINISHED,
      closeReason: 'answered',
      withheldFields: [],
      createdAt: STAMP,
      updatedAt: FINISHED,
      workflowStepOrdinal: 2,
      workflowStepSlug: 'question',
    },
    audits: [{ id: AUDIT, action: 'rule', actorSession: 'session', at: FINISHED, reason: null }],
  }
}

function liveQuestion(): QuestionWriteBody {
  const { audits: _audits, ...imported } = questionImport(QUESTION_LIVE, REQUEST_LIVE)
  return {
    ...imported,
    question: { ...imported.question, number: null, revision: 1, answer: null },
    audit: { action: 'ask', actorSession: 'session', at: FINISHED, reason: null },
  }
}

test('task-flow import is exact and idempotent while minting stage numbers in body order', async () => {
  const sql = pgliteSql(postgres)
  const input = flowImport()
  const first = await writeRecordTaskFlowTransaction(
    'import',
    { ...principal, ...input },
    sql,
    pgliteJsonb,
  )
  const second = await writeRecordTaskFlowTransaction(
    'import',
    { ...principal, ...input },
    sql,
    pgliteJsonb,
  )
  expect(first.stages).toEqual([
    { id: STAGE_TWO, number: 1 },
    { id: STAGE_ONE, number: 2 },
  ])
  expect(second).toEqual(first)
  expect(
    (
      await postgres.query(
        `SELECT state,revision,created_at,updated_at FROM task_flow WHERE id='${FLOW}'`,
      )
    ).rows,
  ).toEqual([
    { state: 'done', revision: 7, created_at: new Date(STAMP), updated_at: new Date(FINISHED) },
  ])
  expect((await postgres.query('SELECT count(*)::int count FROM board_claim')).rows).toEqual([
    { count: 0 },
  ])
  expect(
    (
      await postgres.query(
        `SELECT id,stage_record_id,step_ordinal,step_slug,floor
         FROM workflow_obligation WHERE id='${OBLIGATION}'`,
      )
    ).rows,
  ).toEqual([
    {
      id: OBLIGATION,
      stage_record_id: STAGE_TWO,
      step_ordinal: 1,
      step_slug: 'second',
      floor: 'test',
    },
  ])
  expect(
    (
      await postgres.query(
        `SELECT id,stage_record_id,step_ordinal,step_slug,body
         FROM workflow_step_text WHERE id='${TEXT}'`,
      )
    ).rows,
  ).toEqual([
    {
      id: TEXT,
      stage_record_id: STAGE_TWO,
      step_ordinal: 1,
      step_slug: 'second',
      body: 'historical step text',
    },
  ])
  expect(
    (
      await postgres.query(
        `SELECT id,workflow_text_record_id,stage_record_id,task_document_reference
         FROM workflow_text_copy WHERE id='${COPY}'`,
      )
    ).rows,
  ).toEqual([
    {
      id: COPY,
      workflow_text_record_id: TEXT,
      stage_record_id: STAGE_TWO,
      task_document_reference: 'DEV-2419/1',
    },
  ])

  const changed = flowImport()
  changed.stages[0]!.activeSlug = 'changed'
  await expect(
    writeRecordTaskFlowTransaction('import', { ...principal, ...changed }, sql, pgliteJsonb),
  ).rejects.toMatchObject({ reason: 'already-exists' })

  const live = stage(STAGE_LIVE, 'live')
  const liveResult = await writeRecordTaskFlowTransaction(
    'compose',
    { ...principal, requestId: REQUEST_LIVE, stageInsert: live, stageChanges: [] },
    sql,
    pgliteJsonb,
  )
  expect(liveResult.stage).toEqual({ id: STAGE_LIVE, number: 3 })
})

test('question import preserves history, audits, idempotency, and numbering beside live asks', async () => {
  const sql = pgliteSql(postgres)
  const firstInput = questionImport(QUESTION_ONE, REQUEST)
  const first = await writeRecordQuestionTransaction('import', { ...principal, ...firstInput }, sql)
  const repeated = await writeRecordQuestionTransaction(
    'import',
    { ...principal, ...firstInput },
    sql,
  )
  const second = await writeRecordQuestionTransaction(
    'import',
    { ...principal, ...questionImport(QUESTION_TWO, REQUEST_TWO), audits: [] },
    sql,
  )
  const live = await writeRecordQuestionTransaction('ask', { ...principal, ...liveQuestion() }, sql)
  expect([first.number, repeated.number, second.number, live.number]).toEqual([1, 1, 2, 3])
  expect(repeated.replayed).toBe(true)
  expect(
    (
      await postgres.query(`
      SELECT revision,answer,answered_at,closed_at,created_at,updated_at,
             workflow_step_ordinal,workflow_step_slug
      FROM question WHERE id='${QUESTION_ONE}'
    `)
    ).rows,
  ).toEqual([
    {
      revision: 3,
      answer: 'yes',
      answered_at: new Date(FINISHED),
      closed_at: new Date(FINISHED),
      created_at: new Date(STAMP),
      updated_at: new Date(FINISHED),
      workflow_step_ordinal: 2,
      workflow_step_slug: 'question',
    },
  ])
  expect(
    (await postgres.query(`SELECT id FROM question_mutation_audit WHERE id='${AUDIT}'`)).rows,
  ).toEqual([{ id: AUDIT }])

  const changed = questionImport(QUESTION_ONE, REQUEST)
  changed.question.answer = 'no'
  await expect(
    writeRecordQuestionTransaction('import', { ...principal, ...changed }, sql),
  ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('different content') })
})
