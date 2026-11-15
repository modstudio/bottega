import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../shared/record-id.ts'
import { applyMigrations } from '../src/database/migrations.ts'
import { questionStore, recordQuestionStore } from '../src/question-store/question-store.ts'
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
  test.only('direct question asks allocate atomically, seed above the maximum, and retry once', async () => {
    const fixture = input()
    const machineId = newRecordId()
    const at = '2026-11-15T12:00:00.000Z'
    const directTaskId = newRecordId()
    const directSpaceId = newRecordId()
    const directProjectId = newRecordId()
    const directProjectName = `direct-question-proof-${directProjectId.slice(-8)}`
    fixture.admin(`
      INSERT INTO space(id,name,slug,metadata,created_at)
      VALUES ('${directSpaceId}','${directProjectName}','${directProjectName}','{}'::jsonb,now());
      INSERT INTO membership(id,space_id,user_id,role,permission,created_at)
      VALUES ('${newRecordId()}','${directSpaceId}',
        (SELECT user_id FROM membership WHERE space_id='${fixture.spaceId}' LIMIT 1),
        'member','write',now());
      INSERT INTO machine(id,user_id,name,registered_at,last_seen)
      VALUES ('${machineId}',(SELECT user_id FROM membership WHERE space_id='${directSpaceId}' LIMIT 1),
        'direct-question-proof',now(),now());
      INSERT INTO project(id,space_id,name,created_at)
      VALUES ('${directProjectId}','${directSpaceId}','${directProjectName}',now());
      INSERT INTO question
        (id,number,space_id,project_id,machine_id,revision,asked_at,question,asked_via,
         withheld_fields,created_at,updated_at)
      VALUES ('${newRecordId()}',40,'${directSpaceId}','${directProjectId}','${machineId}',1,
        '${at}','seed question','workflow','[]'::jsonb,'${at}','${at}');
      INSERT INTO hub_task
        (id,space_id,project_name,project_id,key,project,title,status,status_category,source,
         first_seen,last_seen,created_at,updated_at)
      VALUES ('${directTaskId}','${directSpaceId}','${directProjectName}','${directProjectId}',
        'DEV-2331','${directProjectName}','direct question task','active','active','local',
        now(),now(),now(),now());
    `)
    fixture.signIn()
    const client = recordApiClient()
    const destination = { destinationSpaceId: directSpaceId }
    type QuestionSnapshot = QuestionWriteBody['question']
    const snapshot = (id: string): QuestionSnapshot => ({
      id,
      number: null,
      runId: null,
      workflowKey: 'DEV-2331',
      workflowTaskId: null,
      workflowCursorRecordId: newRecordId(),
      projectId: directProjectId,
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
    const unknown = snapshot(newRecordId())
    await expect(
      client.writeQuestion!(
        'answer',
        {
          requestId: newRecordId(),
          question: unknown,
          audit: { action: 'answer', actorSession: null, at, reason: null },
        },
        destination,
      ),
    ).rejects.toThrow('not found')
    expect(fixture.admin(`SELECT count(*) FROM question WHERE id='${unknown.id}';`)).toBe('0')
    const questions = Array.from({ length: 4 }, () => snapshot(newRecordId()))
    const written = await Promise.all(questions.map((question) => ask(question)))
    expect(written.map(({ number }) => number).sort((a, b) => a - b)).toEqual([41, 42, 43, 44])
    expect(
      fixture.admin(`SELECT workflow_task_id FROM question WHERE id='${questions[0]!.id}';`),
    ).toBe(directTaskId)

    await client.ensureSpaceBuiltIns!({ destinationSpaceId: directSpaceId })
    const workflowVersionId = fixture.admin(
      `SELECT version.id FROM workflow_version version JOIN workflow ON workflow.id=version.workflow_id
       WHERE workflow.space_id='${directSpaceId}' ORDER BY version.n DESC LIMIT 1;`,
    )
    const catalogueVersionId = fixture.admin(
      `SELECT version.id FROM step_catalogue_version version JOIN step_catalogue catalogue ON catalogue.id=version.catalogue_id
       WHERE catalogue.space_id='${directSpaceId}' ORDER BY version.n DESC LIMIT 1;`,
    )
    const flowId = newRecordId()
    const stageId = newRecordId()
    await client.composeTaskFlow!(
      {
        requestId: newRecordId(),
        flowInsert: {
          id: flowId,
          projectId: directProjectId,
          taskId: directTaskId,
          state: 'open',
          openStageRecordId: stageId,
          openingMachineId: machineId,
          updatedMachineId: machineId,
          createdAt: at,
          updatedAt: at,
        },
        stageInsert: {
          id: stageId,
          flowRecordId: flowId,
          projectId: directProjectId,
          workflow: 'ship-task',
          mode: 'default',
          workflowKey: 'DEV-2331',
          instanceId: '',
          sessionId: 'question-proof-session',
          workflowVersionId,
          catalogueVersionId,
          arguments: { key: 'DEV-2331' },
          activeOrdinal: 0,
          activeSlug: 'implement',
          state: 'awaiting-ruling',
          closedStepNotes: [],
          question: null,
          autonomy: null,
          enforcement: 'note-only',
          totalSteps: 1,
          openedMachineId: machineId,
          takenOverFromMachineId: null,
          lastAdvancedMachineId: machineId,
          createdAt: at,
          updatedAt: at,
        },
      },
      destination,
    )
    const runId = newRecordId()
    fixture.admin(`INSERT INTO run
      (id,evidence_seq,space_id,project_id,machine_id,started_by_user_id,started_at,agent,job,
       prompt_sha,prompt_bytes,prompt_head,task_id,probe,status,turn,no_failover,automatic_failover,
       work_preserved,created_at,updated_at,session_id)
      VALUES ('${runId}',(SELECT COALESCE(MAX(evidence_seq),0)+1 FROM run WHERE space_id='${directSpaceId}'),
       '${directSpaceId}','${directProjectId}','${machineId}',
       (SELECT user_id FROM membership WHERE space_id='${directSpaceId}' LIMIT 1),'${at}',
       'codex','proof','proof',1,'proof','${directTaskId}',false,'running',1,false,false,false,
       '${at}','${at}','run-question-proof');`)
    const workflowQuestion = snapshot(newRecordId())
    workflowQuestion.workflowCursorRecordId = stageId
    const runQuestion = snapshot(newRecordId())
    runQuestion.runId = runId
    runQuestion.workflowCursorRecordId = null
    await ask(workflowQuestion)
    await ask(runQuestion)
    expect((await client.readQuestions!({ read: 'waiting' }, destination)).items).toContainEqual(
      expect.objectContaining({ question_record_id: workflowQuestion.id }),
    )
    expect(
      (
        await client.readQuestions!(
          { read: 'open-for-session', sessionId: 'question-proof-session' },
          destination,
        )
      ).items,
    ).toContainEqual(
      expect.objectContaining({ record_id: stageId, open_question_record_id: workflowQuestion.id }),
    )
    const inbox = (await client.readQuestions!({ read: 'inbox' }, destination)).items
    expect(inbox).toContainEqual(expect.objectContaining({ record_id: workflowQuestion.id }))
    expect(inbox).toContainEqual(expect.objectContaining({ record_id: runQuestion.id }))
    expect(
      (await client.readQuestions!({ read: 'rulings', kind: 'workflow' }, destination)).items,
    ).toContainEqual(expect.objectContaining({ record_id: workflowQuestion.id }))
    expect(
      (await client.readQuestions!({ read: 'rulings', kind: 'run' }, destination)).items,
    ).toContainEqual(expect.objectContaining({ record_id: runQuestion.id }))
    expect((await client.readQuestions!({ read: 'projects' }, destination)).items).toContainEqual({
      project: directProjectName,
    })

    const answeredAt = '2026-11-15T12:01:00.000Z'
    Object.assign(workflowQuestion, {
      revision: 2,
      answer: 'Yes',
      answeredAt,
      updatedAt: answeredAt,
    })
    await client.writeQuestion!(
      'answer',
      {
        requestId: newRecordId(),
        question: workflowQuestion,
        audit: { action: 'answer', actorSession: null, at: answeredAt, reason: null },
      },
      destination,
    )
    const overturnedAt = '2026-11-15T12:01:30.000Z'
    Object.assign(workflowQuestion, {
      revision: 3,
      overturnedAt,
      replacement: 'No',
      updatedAt: overturnedAt,
    })
    await client.writeQuestion!(
      'overturn',
      {
        requestId: newRecordId(),
        question: workflowQuestion,
        audit: { action: 'overturn', actorSession: null, at: overturnedAt, reason: null },
      },
      destination,
    )
    const excludedQuestion = snapshot(newRecordId())
    excludedQuestion.workflowCursorRecordId = stageId
    await ask(excludedQuestion)
    Object.assign(excludedQuestion, {
      revision: 2,
      answer: 'Old',
      answeredAt,
      updatedAt: answeredAt,
    })
    await client.writeQuestion!(
      'answer',
      {
        requestId: newRecordId(),
        question: excludedQuestion,
        audit: { action: 'answer', actorSession: null, at: answeredAt, reason: null },
      },
      destination,
    )
    Object.assign(excludedQuestion, {
      revision: 3,
      overturnedAt,
      replacement: null,
      updatedAt: overturnedAt,
    })
    await client.writeQuestion!(
      'overturn',
      {
        requestId: newRecordId(),
        question: excludedQuestion,
        audit: { action: 'overturn', actorSession: null, at: overturnedAt, reason: null },
      },
      destination,
    )
    const taskRulings = (
      await client.readQuestions!(
        { read: 'task-rulings', projectId: directProjectId, taskId: directTaskId },
        destination,
      )
    ).items
    expect(taskRulings).toContainEqual(
      expect.objectContaining({ question_record_id: workflowQuestion.id, replacement: 'No' }),
    )
    expect(taskRulings).not.toContainEqual(
      expect.objectContaining({ question_record_id: excludedQuestion.id }),
    )
    const closedAt = '2026-11-15T12:02:00.000Z'
    Object.assign(runQuestion, { revision: 2, closedAt, closeReason: 'proof', updatedAt: closedAt })
    await client.writeQuestion!(
      'close',
      {
        requestId: newRecordId(),
        question: runQuestion,
        audit: { action: 'close', actorSession: null, at: closedAt, reason: null },
      },
      destination,
    )
    expect((await client.readQuestions!({ read: 'inbox' }, destination)).items).not.toContainEqual(
      expect.objectContaining({ record_id: runQuestion.id }),
    )

    const parityLocal = new Database(':memory:')
    applyMigrations(parityLocal)
    parityLocal.exec('PRAGMA foreign_keys=OFF')
    parityLocal
      .query('INSERT INTO project(record_id,name,path,stack,settings) VALUES (?,?,?,?,?)')
      .run(directProjectId, directProjectName, '/fixture', 'bun', '{}')
    parityLocal
      .query(`INSERT INTO workflow_cursor
        (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
         session_id,workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,
         closed,question,total_steps,created_at,updated_at)
        VALUES (?,1,?,?,'ship-task','default','DEV-2331','fixture','question-proof-session',
          ?,?,'{}',0,'implement','awaiting-ruling','[]',NULL,1,?,?)`)
      .run(stageId, directProjectName, directProjectId, workflowVersionId, catalogueVersionId, at, at)
    parityLocal
      .query(`INSERT INTO run
        (record_id,number,started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,session_id,
         launch_key,changed_paths,project_record_id,task_record_id)
        VALUES (?,1,?,'codex','proof',?,'sha',1,'proof','running','run-question-proof',
          'DEV-2331','[]',?,?)`)
      .run(runId, at, directProjectName, directProjectId, directTaskId)
    const projectlessRunId = newRecordId()
    fixture.admin(`INSERT INTO run
      (id,evidence_seq,space_id,project_id,machine_id,started_by_user_id,started_at,agent,job,
       prompt_sha,prompt_bytes,prompt_head,task_id,probe,status,turn,no_failover,automatic_failover,
       work_preserved,created_at,updated_at,session_id)
      VALUES ('${projectlessRunId}',(SELECT COALESCE(MAX(evidence_seq),0)+1 FROM run WHERE space_id='${directSpaceId}'),
       '${directSpaceId}',NULL,'${machineId}',
       (SELECT user_id FROM membership WHERE space_id='${directSpaceId}' LIMIT 1),'${at}',
       'codex','proof','proof',1,'proof',NULL,true,'running',1,false,false,false,
       '${at}','${at}','projectless-question-proof');`)
    parityLocal
      .query(`INSERT INTO run
        (record_id,number,started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,session_id,probe,
         launch_key,changed_paths,project_record_id,task_record_id)
        VALUES (?,2,?,'codex','proof',NULL,'sha',1,'proof','running','projectless-question-proof',1,
          'DEV-2331','[]',NULL,NULL)`)
      .run(projectlessRunId, at)
    const localStore = questionStore(parityLocal)
    for (const question of [workflowQuestion, excludedQuestion, runQuestion])
      await localStore.write('ask', {
        requestId: newRecordId(),
        question,
        audit: { action: 'ask', actorSession: null, at: question.updatedAt, reason: null },
      })
    const parityWorkflow = snapshot(newRecordId())
    parityWorkflow.workflowCursorRecordId = stageId
    const parityRun = snapshot(newRecordId())
    parityRun.runId = runId
    parityRun.workflowCursorRecordId = null
    const projectlessQuestion = snapshot(newRecordId())
    projectlessQuestion.runId = projectlessRunId
    projectlessQuestion.workflowCursorRecordId = null
    for (const question of [parityWorkflow, parityRun, projectlessQuestion]) {
      await ask(question)
      await localStore.write('ask', {
        requestId: newRecordId(),
        question,
        audit: { action: 'ask', actorSession: null, at, reason: null },
      })
    }
    const hostedStore = recordQuestionStore({
      database: parityLocal,
      destinationSpaceId: directSpaceId,
      client,
      pushRun: async () => {},
    })
    const sameKeys = (label: string, hosted: object | undefined, local: object | undefined) => {
      expect(hosted, `${label} hosted row`).toBeDefined()
      expect(local, `${label} local row`).toBeDefined()
      expect(Object.keys(hosted!).sort(), `${label} keys`).toEqual(Object.keys(local!).sort())
    }
    const hostedInbox = (await hostedStore.read({ read: 'inbox' })).items
    const localInbox = (await localStore.read({ read: 'inbox' })).items
    for (const question of [parityWorkflow, parityRun, projectlessQuestion])
      sameKeys(
        `inbox ${question.id}`,
        hostedInbox.find((row) => 'record_id' in row && row.record_id === question.id),
        localInbox.find((row) => 'record_id' in row && row.record_id === question.id),
      )
    expect(
      hostedInbox.find(
        (row) => 'record_id' in row && row.record_id === projectlessQuestion.id,
      ),
    ).toMatchObject({ repo: null })
    const hostedWaiting = (await hostedStore.read({ read: 'waiting' })).items
    const localWaiting = (await localStore.read({ read: 'waiting' })).items
    sameKeys(
      'waiting',
      hostedWaiting.find(
        (row) => 'question_record_id' in row && row.question_record_id === parityWorkflow.id,
      ),
      localWaiting.find(
        (row) => 'question_record_id' in row && row.question_record_id === parityWorkflow.id,
      ),
    )
    const hostedOpen = (
      await hostedStore.read({ read: 'open-for-session', sessionId: 'question-proof-session' })
    ).items
    const localOpen = (
      await localStore.read({ read: 'open-for-session', sessionId: 'question-proof-session' })
    ).items
    sameKeys('open-for-session', hostedOpen[0], localOpen[0])
    for (const kind of ['workflow', 'run'] as const) {
      const hostedRulings = (await hostedStore.read({ read: 'rulings', kind })).items
      const localRulings = (await localStore.read({ read: 'rulings', kind })).items
      const id = kind === 'workflow' ? parityWorkflow.id : parityRun.id
      sameKeys(
        `rulings ${kind}`,
        hostedRulings.find((row) => 'record_id' in row && row.record_id === id),
        localRulings.find((row) => 'record_id' in row && row.record_id === id),
      )
    }
    const hostedTaskRulings = (
      await hostedStore.read({
        read: 'task-rulings',
        projectId: directProjectId,
        taskId: directTaskId,
      })
    ).items
    const localTaskRulings = (
      await localStore.read({
        read: 'task-rulings',
        projectId: directProjectId,
        taskId: directTaskId,
      })
    ).items
    sameKeys(
      'task-rulings',
      hostedTaskRulings.find(
        (row) =>
          'question_record_id' in row && row.question_record_id === workflowQuestion.id,
      ),
      localTaskRulings.find(
        (row) =>
          'question_record_id' in row && row.question_record_id === workflowQuestion.id,
      ),
    )
    const hostedProjects = (await hostedStore.read({ read: 'projects' })).items
    const localProjects = (await localStore.read({ read: 'projects' })).items
    sameKeys(
      'projects',
      hostedProjects.find((row) => 'project' in row && row.project === directProjectName),
      localProjects.find((row) => 'project' in row && row.project === directProjectName),
    )
    parityLocal.close()
    const retried = snapshot(newRecordId())
    const requestId = newRecordId()
    const retries = await Promise.all([ask(retried, requestId), ask(retried, requestId)])
    expect(retries[0]).toEqual(retries[1])
    expect(
      fixture.admin(
        `SELECT count(*) FROM question_mutation_audit WHERE question_id='${retried.id}';`,
      ),
    ).toBe('1')

    const answerTarget = snapshot(newRecordId())
    await ask(answerTarget)
    const answerSnapshot = {
      ...answerTarget,
      revision: 2,
      answer: 'first answer',
      answeredAt,
      updatedAt: answeredAt,
    }
    const answerWrite = (requestId: string) =>
      client.writeQuestion!(
        'answer',
        {
          requestId,
          question: answerSnapshot,
          audit: { action: 'answer', actorSession: null, at: answeredAt, reason: null },
        },
        destination,
      )
    await answerWrite(newRecordId())
    await expect(answerWrite(newRecordId())).rejects.toThrow(
      `question ${answerTarget.id} already holds hosted revision 2; re-read the question, then retry`,
    )
    expect(
      fixture.admin(
        `SELECT count(*) FROM question_mutation_audit WHERE question_id='${answerTarget.id}' AND action='answer';`,
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
