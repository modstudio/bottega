import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { createHostedRecordFixture, pgliteSql } from '../../test/fixtures/hosted-record.ts'
import { gatherStepQuestionEvidenceFromRows } from '../workflow/workflow-step-question-evidence.ts'
import { type QuestionWriteBody, RecordQuestionError } from './record-question-contract.ts'
import { readRecordQuestionRows } from './record-question-read.ts'
import { writeRecordQuestionTransaction } from './record-question-write.ts'

const SPACE = '01990000-0000-7000-8000-000000002360'
const OTHER_SPACE = '01990000-0000-7000-8000-000000002374'
const USER = '01990000-0000-7000-8000-000000002361'
const PROJECT = '01990000-0000-7000-8000-000000002362'
const MACHINE = '01990000-0000-7000-8000-000000002363'
const WORKFLOW = '01990000-0000-7000-8000-000000002364'
const WORKFLOW_VERSION = '01990000-0000-7000-8000-000000002365'
const CATALOGUE = '01990000-0000-7000-8000-000000002366'
const CATALOGUE_VERSION = '01990000-0000-7000-8000-000000002367'
const FLOW = '01990000-0000-7000-8000-000000002368'
const CURSOR = '01990000-0000-7000-8000-000000002369'
const QUESTION = '01990000-0000-7000-8000-000000002370'
const LEGACY_QUESTION = '01990000-0000-7000-8000-000000002371'
const REQUEST = '01990000-0000-7000-8000-000000002372'
const REWRITE_REQUEST = '01990000-0000-7000-8000-000000002373'
const STAMP = '2026-11-16T12:00:00.000Z'

let postgres: PGlite

beforeEach(async () => {
  postgres = await createHostedRecordFixture({ spaceId: SPACE, userId: USER })
  await postgres.exec(`
    RESET ROLE;
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES ('${PROJECT}','${SPACE}','question-step',ARRAY['DEV'],now());
    INSERT INTO machine (id,user_id,name,registered_at,last_seen)
    VALUES ('${MACHINE}','${USER}','question-step',now(),now());
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
    INSERT INTO task_flow
      (id,space_id,project_id,state,opening_machine_id,updated_machine_id,revision,created_at,updated_at)
    VALUES ('${FLOW}','${SPACE}','${PROJECT}','open','${MACHINE}','${MACHINE}',1,now(),now());
    INSERT INTO task_flow_stage
      (id,space_id,flow_record_id,project_id,number,workflow,mode,workflow_key,session_id,
       workflow_version_id,catalogue_version_id,arguments,active_ordinal,active_slug,state,
       closed_step_notes,total_steps,opened_machine_id,last_advanced_machine_id,revision,created_at,updated_at)
    VALUES ('${CURSOR}','${SPACE}','${FLOW}','${PROJECT}',1,'proof','default','DEV-2368','session',
      '${WORKFLOW_VERSION}','${CATALOGUE_VERSION}','{}',6,'design-signoff','awaiting-ruling',
      '[]',8,'${MACHINE}','${MACHINE}',1,now(),now());
    SET ROLE record_actor;
  `)
})

afterEach(async () => {
  await postgres.close()
})

function questionWrite(requestId = REQUEST, revision = 1): QuestionWriteBody {
  return {
    requestId,
    question: {
      id: QUESTION,
      number: null,
      runId: null,
      workflowKey: null,
      workflowTaskId: null,
      workflowCursorRecordId: CURSOR,
      projectId: null,
      machineId: MACHINE,
      revision,
      askedAt: STAMP,
      question: 'Proceed?',
      options: null,
      recommendation: null,
      why: null,
      askedVia: 'workflow',
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
    },
    audit: {
      action: revision === 1 ? 'ask' : 'link',
      actorSession: 'session',
      at: STAMP,
      reason: null,
    },
  }
}

const principal = { url: 'pglite', userId: USER, spaceId: SPACE, spaceIds: [SPACE] }

async function moveCursorToOtherSpace() {
  await postgres.exec(`
    RESET ROLE;
    INSERT INTO space (id,name,slug,created_at)
    VALUES ('${OTHER_SPACE}','Other question step space','other-question-step-space',now());
    UPDATE task_flow_stage SET space_id='${OTHER_SPACE}' WHERE id='${CURSOR}';
    SET ROLE record_actor;
  `)
}

test('a new cursor question refuses a destination space that does not hold its cursor', async () => {
  await moveCursorToOtherSpace()
  const refusal = writeRecordQuestionTransaction(
    'ask',
    { ...principal, ...questionWrite() },
    pgliteSql(postgres),
  )
  await expect(refusal).rejects.toBeInstanceOf(RecordQuestionError)
  await expect(refusal).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining(
      `workflow cursor ${CURSOR} is absent from the question's destination space; ask through the cursor's project with`,
    ),
  })
})

test('a stored cursor question remains closable when its cursor is in another space', async () => {
  const sql = pgliteSql(postgres)
  await writeRecordQuestionTransaction('ask', { ...principal, ...questionWrite() }, sql)
  await moveCursorToOtherSpace()
  const close = questionWrite(REWRITE_REQUEST, 2)
  close.question.closedAt = '2026-11-17T15:00:00.000Z'
  close.question.closeReason = 'Re-ask through the cursor project.'
  close.question.updatedAt = '2026-11-17T15:00:00.000Z'
  close.audit.action = 'close'
  close.audit.at = '2026-11-17T15:00:00.000Z'

  await expect(
    writeRecordQuestionTransaction('close', { ...principal, ...close }, sql),
  ).resolves.toMatchObject({ applied: true, revision: 2 })
})

test('production hosted write keeps the question step through a later-step rewrite', async () => {
  const sql = pgliteSql(postgres)
  expect(
    await writeRecordQuestionTransaction('ask', { ...principal, ...questionWrite() }, sql),
  ).toMatchObject({ applied: true, revision: 1 })
  expect(
    await writeRecordQuestionTransaction('ask', { ...principal, ...questionWrite() }, sql),
  ).toMatchObject({ applied: true, replayed: true, revision: 1 })

  await postgres.exec(
    `UPDATE task_flow_stage SET active_ordinal=7,active_slug='implementation' WHERE id='${CURSOR}'`,
  )
  expect(
    await writeRecordQuestionTransaction(
      'link',
      { ...principal, ...questionWrite(REWRITE_REQUEST, 2) },
      sql,
    ),
  ).toMatchObject({ applied: true, revision: 2 })
  expect(
    (
      await postgres.query(
        `SELECT workflow_step_ordinal,workflow_step_slug FROM question WHERE id='${QUESTION}'`,
      )
    ).rows,
  ).toEqual([{ workflow_step_ordinal: 7, workflow_step_slug: 'design-signoff' }])
})

test('production hosted reads preserve stored steps and fall back on the correct ordinal base', async () => {
  const sql = pgliteSql(postgres)
  await writeRecordQuestionTransaction('ask', { ...principal, ...questionWrite() }, sql)
  await postgres.exec(`
    UPDATE task_flow_stage SET active_ordinal=7,active_slug='implementation' WHERE id='${CURSOR}';
    RESET ROLE;
    INSERT INTO question
      (id,number,space_id,workflow_cursor_record_id,machine_id,revision,asked_at,question,
       workflow_step_ordinal,workflow_step_slug,withheld_fields,created_at,updated_at)
    VALUES ('${LEGACY_QUESTION}',2,'${SPACE}','${CURSOR}','${MACHINE}',1,'${STAMP}','Legacy?',
      NULL,NULL,'[]','${STAMP}','${STAMP}');
    SET ROLE record_actor;
  `)

  const forCursor = (
    await readRecordQuestionRows(sql, {
      read: 'for-cursor',
      workflowCursorRecordId: CURSOR,
    })
  ).items
  expect(forCursor).toMatchObject([
    { number: 1, workflow_step_ordinal: 7, workflow_step_slug: 'design-signoff' },
    { number: 2, workflow_step_ordinal: 8, workflow_step_slug: 'implementation' },
  ])
  expect(
    gatherStepQuestionEvidenceFromRows(
      forCursor,
      { stepOrdinal: 8, stepSlug: 'implementation' },
      () => ({ state: 'open' as const, answeredAt: null, replacement: null }),
    ),
  ).toEqual({ stepQuestion: { id: 2, state: 'open', answeredAt: null, replacement: null } })

  expect((await readRecordQuestionRows(sql, { read: 'inbox' })).items).toMatchObject([
    { number: 1, ordinal: 6, step_slug: 'design-signoff' },
    { number: 2, ordinal: 7, step_slug: 'implementation' },
  ])
})
