import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record-id.ts'
import { applyMigrations } from '../src/database/migrations.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from '../src/record/outbox-payload-contracts.ts'
import { recordApiClient } from '../src/record/record-api-client.ts'
import type { QuestionWriteBody } from '../src/record/record-question-contract.ts'
import { syncRecord } from '../src/record/record-sync.ts'
import { registerHostedTaskLinkConvergenceProof } from './postgres-task-link-convergence-proof.ts'

type PsqlResult = { code: number; stdout: string; stderr: string }

const QUESTION_RECORD_PAYLOAD_COLUMNS = OUTBOX_PAYLOAD_CONTRACTS.question.columns
const QUESTION_TASK_PROOF_MACHINE = newRecordId()

export function registerQuestionTaskRecordSyncProof(
  input: () => {
    actorRole: string
    spaceId: string
    otherSpaceId: string
    projectName: string
    projectId: string
    signIn: () => void
    asSpace: (user: string, password: string, spaceId: string, statement: string) => PsqlResult
    admin: (statement: string) => string
  },
): void {
  test('question sync resolves one live workflow key and preserves the link on a null re-push', async () => {
    const fixture = input()
    const local = new Database(':memory:')
    applyMigrations(local)
    const taskId = newRecordId()
    const questionId = newRecordId()
    const workflowKey = 'AA-1772'
    fixture.admin(`INSERT INTO hub_task
      (id,space_id,project_name,project_id,key,project,title,status,status_category,source,
       first_seen,last_seen,created_at,updated_at)
      VALUES ('${taskId}','${fixture.spaceId}','${fixture.projectName}','${fixture.projectId}',
        '${workflowKey}','${fixture.projectName}','question task proof','active','active','local',
        now(),now(),now(),now());`)

    const question = Object.fromEntries(
      QUESTION_RECORD_PAYLOAD_COLUMNS.map((column) => [column, null]),
    )
    Object.assign(question, {
      id: questionId,
      spaceId: fixture.spaceId,
      workflowKey,
      projectId: fixture.projectId,
      projectName: fixture.projectName,
      machineId: QUESTION_TASK_PROOF_MACHINE,
      localId: 1772,
      revision: 1,
      askedAt: '2026-10-26T00:00:00.000Z',
      question: 'Does the workflow key resolve to its hosted task?',
      askedVia: 'workflow',
      audits: [],
      withheldFields: [],
      createdAt: '2026-10-26T00:00:00.000Z',
      updatedAt: '2026-10-26T00:00:00.000Z',
    })
    delete question.workflowTaskId
    local
      .query(
        "INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at) VALUES (?,1,'question',?,?,?)",
      )
      .run(newRecordId(), questionId, JSON.stringify(question), String(question.createdAt))

    const sync = () =>
      syncRecord({
        local,
        identity: { id: QUESTION_TASK_PROOF_MACHINE, name: 'question-task-proof' },
        projectSpaces: { [fixture.projectName]: fixture.spaceId },
      })
    expect(await sync()).toMatchObject({ pushed: 1, failed: 0, pending: 0 })
    const readLink = () =>
      fixture.asSpace(
        fixture.actorRole,
        'actor-password',
        fixture.spaceId,
        `SELECT workflow_task_id FROM question WHERE id='${questionId}';`,
      )
    expect(readLink().stdout).toBe(taskId)

    question.workflowTaskId = null
    local
      .query('UPDATE outbox SET payload=?,synced_at=NULL WHERE id=1')
      .run(JSON.stringify(question))
    expect(await sync()).toMatchObject({ pushed: 1, failed: 0, pending: 0 })
    expect(readLink().stdout).toBe(taskId)
    local.close()
  })
  test('direct question asks allocate atomically, seed above the maximum, and retry once', async () => {
    const fixture = input()
    const machineId = newRecordId()
    const at = '2026-11-15T12:00:00.000Z'
    fixture.admin(`
      INSERT INTO machine(id,user_id,name,registered_at,last_seen)
      VALUES ('${machineId}',(SELECT user_id FROM membership WHERE space_id='${fixture.spaceId}' LIMIT 1),
        'direct-question-proof',now(),now());
      INSERT INTO question
        (id,number,space_id,project_id,machine_id,revision,asked_at,question,asked_via,
         withheld_fields,created_at,updated_at)
      VALUES ('${newRecordId()}',40,'${fixture.spaceId}','${fixture.projectId}','${machineId}',1,
        '${at}','seed question','workflow','[]'::jsonb,'${at}','${at}');
    `)
    fixture.signIn()
    const client = recordApiClient()
    const destination = { destinationSpaceId: fixture.spaceId }
    type QuestionSnapshot = QuestionWriteBody['question']
    const snapshot = (id: string): QuestionSnapshot => ({
      id,
      number: null,
      runId: null,
      workflowKey: 'DEV-2331',
      workflowTaskId: null,
      workflowCursorRecordId: newRecordId(),
      projectId: fixture.projectId,
      machineId,
      revision: 1,
      askedAt: at,
      question: `direct question ${id}`,
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
      awaitingOperatorAt: at,
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
      createdAt: at,
      updatedAt: at,
    })
    const ask = (question: QuestionSnapshot, requestId = newRecordId()) =>
      client.writeQuestion!(
        'ask',
        {
          requestId,
          question,
          audit: { action: 'ask', actorSession: 'proof', at, reason: null },
        },
        destination,
      )
    const questions = Array.from({ length: 4 }, () => snapshot(newRecordId()))
    const written = await Promise.all(questions.map((question) => ask(question)))
    expect(written.map(({ number }) => number).sort((a, b) => a - b)).toEqual([41, 42, 43, 44])
    const retried = snapshot(newRecordId())
    const requestId = newRecordId()
    expect(await ask(retried, requestId)).toEqual(await ask(retried, requestId))
    expect(
      fixture.admin(
        `SELECT count(*) FROM question_mutation_audit WHERE question_id='${retried.id}';`,
      ),
    ).toBe('1')

    const rolledBack = snapshot(newRecordId())
    fixture.admin(`
      CREATE OR REPLACE FUNCTION reject_question_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='proof-fail' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_question_audit BEFORE INSERT ON question_mutation_audit
      FOR EACH ROW EXECUTE FUNCTION reject_question_audit();
    `)
    await expect(
      client.writeQuestion!(
        'ask',
        {
          requestId: newRecordId(),
          question: rolledBack,
          audit: { action: 'proof-fail', actorSession: null, at, reason: null },
        },
        destination,
      ),
    ).rejects.toThrow()
    fixture.admin(
      'DROP TRIGGER reject_question_audit ON question_mutation_audit; DROP FUNCTION reject_question_audit();',
    )
    expect(fixture.admin(`SELECT count(*) FROM question WHERE id='${rolledBack.id}';`)).toBe('0')
  })
  registerHostedTaskLinkConvergenceProof(input)
}
