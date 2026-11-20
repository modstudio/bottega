import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  createRecordContractFixture,
  RECORD_CONTRACT_SPACE_A,
  RECORD_CONTRACT_USER,
  type RecordContractFixture,
} from '../../test/fixtures/record-contract.ts'
import { isRunQuestionOwnerNotLive } from '../question-store/run-question-write-guard.ts'
import type { QuestionWriteBody } from './record-question-contract.ts'

const MACHINE = '01990000-0000-7000-8000-000000024580'
const PROJECT = '01990000-0000-7000-8000-000000024581'
const RUN = '01990000-0000-7000-8000-000000024582'
const QUESTION = '01990000-0000-7000-8000-000000024583'
const REQUEST = '01990000-0000-7000-8000-000000024584'
const STAMP = '2026-11-20T05:00:00.000Z'

let fixture: RecordContractFixture

function ask(): QuestionWriteBody {
  return {
    requestId: REQUEST,
    question: {
      id: QUESTION,
      number: null,
      runId: RUN,
      workflowKey: null,
      workflowTaskId: null,
      workflowCursorRecordId: null,
      projectId: PROJECT,
      machineId: MACHINE,
      revision: 1,
      askedAt: STAMP,
      question: 'Proceed?',
      options: null,
      recommendation: null,
      why: null,
      askedVia: 'live',
      kind: 'yesno',
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
    audit: { action: 'ask', actorSession: 'contract-test', at: STAMP, reason: null },
  }
}

beforeAll(async () => {
  fixture = await createRecordContractFixture()
  await fixture.database.exec(`
    RESET ROLE;
    INSERT INTO machine (id,user_id,name,registered_at,last_seen)
    VALUES ('${MACHINE}','${RECORD_CONTRACT_USER}','Question contract machine',now(),now());
    INSERT INTO project (id,space_id,name,key_prefixes,created_at)
    VALUES ('${PROJECT}','${RECORD_CONTRACT_SPACE_A}','question-contract',ARRAY['DEV'],now());
    INSERT INTO run (
      id,space_id,machine_id,started_by_user_id,started_at,agent,job,prompt_sha,prompt_bytes,
      prompt_head,probe,project_id,status,turn,no_failover,automatic_failover,work_preserved,
      withheld_fields,created_at,updated_at
    ) VALUES (
      '${RUN}','${RECORD_CONTRACT_SPACE_A}','${MACHINE}','${RECORD_CONTRACT_USER}','${STAMP}',
      'codex','implement','sha',1,'prompt',false,'${PROJECT}','ok',1,false,false,false,'[]',
      '${STAMP}','${STAMP}'
    );
    SET ROLE record_actor;
  `)
})

afterAll(async () => {
  if (fixture) await fixture.close()
})

test('a hosted ask for a terminal run preserves the typed refusal through HTTP', async () => {
  const error = await fixture.client
    .writeQuestion?.('ask', ask(), { destinationSpaceId: RECORD_CONTRACT_SPACE_A })
    .catch((failure: unknown) => failure)

  expect(isRunQuestionOwnerNotLive(error)).toBe(true)
  expect(error).toMatchObject({ runId: RUN })
  expect(fixture.requestedRoutes).toContain('POST /v1/questions/ask')
})
