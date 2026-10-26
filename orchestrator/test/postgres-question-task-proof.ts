import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record-id.ts'
import { applyMigrations } from '../src/database/migrations.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from '../src/record/outbox-payload-contracts.ts'
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
  registerHostedTaskLinkConvergenceProof(input)
}
