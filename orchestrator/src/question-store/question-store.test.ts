import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { SESSION_LIVE_MS } from '../../../shared/session-liveness.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { QuestionWriteBody } from '../record/record-question-contract.ts'
import { recordQuestionStore } from './question-store-record-factory.ts'
import { questionStore } from './question-store.ts'
import type { QuestionStore } from './question-store-types.ts'

const STAMP = '2026-11-15T12:00:00.000Z'
const PROJECT_ID = '00000000-0000-4000-8000-000000000101'
const TASK_ID = '00000000-0000-4000-8000-000000000102'
const CURSOR_ID = '00000000-0000-4000-8000-000000000103'
const RUN_ID = '00000000-0000-4000-8000-000000000104'
const WORKFLOW_QUESTION_ID = '00000000-0000-4000-8000-000000000105'
const RUN_QUESTION_ID = '00000000-0000-4000-8000-000000000106'
const EXCLUDED_QUESTION_ID = '00000000-0000-4000-8000-000000000108'
type QuestionSnapshot = QuestionWriteBody['question']
const field = (row: object, key: string): unknown => (row as Record<string, unknown>)[key]

function snapshot(overrides: Partial<QuestionSnapshot> = {}): QuestionSnapshot {
  return {
    id: newRecordId(),
    number: null,
    runId: null,
    workflowKey: 'DEV-2331',
    workflowTaskId: null,
    workflowCursorRecordId: CURSOR_ID,
    projectId: PROJECT_ID,
    machineId: newRecordId(),
    revision: 1,
    askedAt: STAMP,
    question: 'Proceed?',
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
    ...overrides,
  }
}

function seedOwners(database: Database): void {
  database.exec('PRAGMA foreign_keys=OFF')
  database
    .query('INSERT INTO project(record_id,name,path,stack,settings) VALUES (?,?,?,?,?)')
    .run(PROJECT_ID, 'question-fixture', '/fixture', 'bun', '{}')
  database
    .query(`INSERT INTO workflow_cursor
    (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
     session_id,workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,
     closed,question,total_steps,created_at,updated_at)
    VALUES (?,1,'question-fixture',?,'ship-task','default','DEV-2331','fixture','owner-session',
      ?,?,'{}',0,'implement','awaiting-ruling','[]',NULL,1,?,?)`)
    .run(CURSOR_ID, PROJECT_ID, newRecordId(), newRecordId(), STAMP, STAMP)
  database
    .query(`INSERT INTO run
    (record_id,number,started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,session_id,
     launch_key,changed_paths,project_record_id,task_record_id)
    VALUES (?,1,?,'codex','implement','question-fixture','sha',1,'prompt','running','run-session',
      'DEV-2331','[]',?,?)`)
    .run(RUN_ID, STAMP, PROJECT_ID, TASK_ID)
}

const body = (
  question: QuestionSnapshot,
  action = 'ask',
  requestId = newRecordId(),
): QuestionWriteBody => ({
  requestId,
  question,
  audit: { action, actorSession: 'session-a', at: question.updatedAt, reason: null },
})

async function mutate(
  store: QuestionStore,
  intent: 'answer' | 'close' | 'overturn',
  question: QuestionSnapshot,
  changes: Partial<QuestionSnapshot>,
): Promise<QuestionSnapshot> {
  const next = { ...question, revision: question.revision + 1, ...changes }
  await store.write(intent, body(next, intent))
  return next
}

async function questionStoreContract(store: QuestionStore, database: Database) {
  const unknown = snapshot({ id: newRecordId() })
  await expect(store.write('answer', body(unknown, 'answer'))).rejects.toThrow('not found')
  expect(
    database
      .query<{ count: number }, [string]>('SELECT count(*) count FROM question WHERE record_id=?')
      .get(unknown.id)!.count,
  ).toBe(0)
  const workflow = snapshot({ id: WORKFLOW_QUESTION_ID, workflowTaskId: TASK_ID })
  const ask = body(workflow, 'ask')
  const first = await store.write('ask', ask)
  expect(first).toMatchObject({ id: workflow.id, revision: 1 })
  expect(await store.write('ask', ask)).toEqual(first)

  const waiting = (await store.read({ read: 'waiting' })).items
  expect(waiting).toHaveLength(1)
  expect(waiting[0]).toMatchObject({
    workflow_cursor_record_id: CURSOR_ID,
    question_record_id: workflow.id,
    project: 'question-fixture',
  })
  const open = (await store.read({ read: 'open-for-session', sessionId: 'owner-session' })).items
  expect(open[0]).toMatchObject({ record_id: CURSOR_ID, open_question_record_id: workflow.id })

  const run = snapshot({
    id: RUN_QUESTION_ID,
    runId: RUN_ID,
    workflowCursorRecordId: null,
    workflowTaskId: TASK_ID,
    askedVia: 'live',
  })
  await store.write('ask', body(run))
  expect((await store.read({ read: 'by-id', ids: [run.id] })).items).toHaveLength(1)
  expect((await store.read({ read: 'for-run', runId: RUN_ID })).items).toHaveLength(1)
  expect(
    (
      await store.read({
        read: 'for-cursor',
        workflowCursorRecordId: CURSOR_ID,
      })
    ).items,
  ).toHaveLength(1)
  expect((await store.read({ read: 'waiting' })).items).toHaveLength(1)
  const inbox = (await store.read({ read: 'inbox' })).items
  expect(inbox.some((row) => field(row, 'record_id') === run.id)).toBe(true)
  expect(inbox.some((row) => field(row, 'record_id') === workflow.id)).toBe(true)
  expect((await store.read({ read: 'inbox', limit: 1 })).items).toHaveLength(1)
  expect(inbox).toHaveLength(2)

  const workflowRulings = (await store.read({ read: 'rulings', kind: 'workflow' })).items
  expect(workflowRulings).toHaveLength(1)
  expect(workflowRulings.every((row) => field(row, 'record_id') !== run.id)).toBe(true)
  const runRulings = (await store.read({ read: 'rulings', kind: 'run' })).items
  expect(runRulings).toHaveLength(1)
  expect(runRulings[0]).toMatchObject({ record_id: run.id, run_record_id: RUN_ID })

  const answeredAt = '2026-11-15T12:01:00.000Z'
  const answered = await mutate(store, 'answer', workflow, {
    answer: 'Yes',
    answeredAt,
    answeredBy: 'architect',
    answeredByKind: 'architect',
    answererKind: 'agent',
    answerChannel: 'mcp',
    updatedAt: answeredAt,
  })
  const ruled = { ...answered, revision: answered.revision + 1 }
  const rule = body(ruled, 'rule')
  rule.audit.reason = 'adopted cursor'
  await store.write('link', rule)
  expect(
    (
      await store.read({
        read: 'rule-audit-reasons',
        workflowCursorRecordId: CURSOR_ID,
        actorSession: 'session-a',
      })
    ).items,
  ).toEqual([{ reason: 'adopted cursor' }])
  const relayed = { ...run, revision: run.revision + 1, awaitingOperatorAt: answeredAt }
  await store.write('relay', body(relayed, 'relay'))
  expect((await store.read({ read: 'by-id', ids: [run.id] })).items[0]).toMatchObject({
    awaiting_operator_at: answeredAt,
  })
  const replacement = await mutate(store, 'overturn', ruled, {
    overturnedAt: '2026-11-15T12:02:00.000Z',
    replacement: 'No',
    updatedAt: '2026-11-15T12:02:00.000Z',
  })
  await store.write(
    'file',
    body(
      {
        ...replacement,
        revision: replacement.revision + 1,
        filedAs: 'doc',
        filedRef: 'ruling-doc',
        filedAt: '2026-11-15T12:02:30.000Z',
      },
      'file',
    ),
  )
  const excludedBase = snapshot({
    id: EXCLUDED_QUESTION_ID,
    workflowTaskId: TASK_ID,
    askedAt: '2026-11-15T12:03:00.000Z',
  })
  await store.write('ask', body(excludedBase))
  const excludedAnswered = await mutate(store, 'answer', excludedBase, {
    answer: 'Old',
    answeredAt: '2026-11-15T12:04:00.000Z',
    updatedAt: '2026-11-15T12:04:00.000Z',
  })
  await mutate(store, 'overturn', excludedAnswered, {
    overturnedAt: '2026-11-15T12:05:00.000Z',
    replacement: null,
    updatedAt: '2026-11-15T12:05:00.000Z',
  })
  const taskRows = (
    await store.read({
      read: 'task-rulings',
      projectId: PROJECT_ID,
      taskId: TASK_ID,
    })
  ).items
  expect(taskRows.some((row) => field(row, 'question_record_id') === replacement.id)).toBe(true)
  expect(taskRows.some((row) => field(row, 'question_record_id') === excludedBase.id)).toBe(false)

  const closed = await mutate(store, 'close', relayed, {
    closedAt: '2026-11-15T12:06:00.000Z',
    closeReason: 'done',
    updatedAt: '2026-11-15T12:06:00.000Z',
  })
  expect(closed.closedAt).not.toBeNull()
  expect(
    (await store.read({ read: 'inbox' })).items.some((row) => field(row, 'record_id') === run.id),
  ).toBe(false)
  const projects = (await store.read({ read: 'projects' })).items
  expect(projects).toContainEqual({
    project: 'question-fixture',
  })
}

test('SQLite and record question adapters satisfy every shared read and write contract', async () => {
  const local = migratedTestDatabase()
  const hosted = migratedTestDatabase()
  seedOwners(local)
  seedOwners(hosted)
  const hostedStore = questionStore(hosted)
  await questionStoreContract(questionStore(local), local)
  await questionStoreContract(
    recordQuestionStore({
      database: local,
      destinationSpaceId: newRecordId(),
      pushRun: async () => {},
      client: {
        readQuestions: async (input) =>
          (await hostedStore.read(input)) as { items: Record<string, unknown>[] },
        writeQuestion: (intent, input) => hostedStore.write(intent, input),
      },
    }),
    hosted,
  )
  local.close()
  hosted.close()
})

test('only the record adapter passes a rulings feed cursor through', async () => {
  const database = migratedTestDatabase()
  await expect(
    questionStore(database).read({ read: 'rulings', kind: 'all', changedAfter: 'cursor-7' }),
  ).rejects.toThrow('changedAfter is served only on a hosted install')
  const store = recordQuestionStore({
    database,
    destinationSpaceId: newRecordId(),
    client: {
      readQuestions: async (input) => ({
        items: [{ number: 1, record_id: WORKFLOW_QUESTION_ID }],
        cursor: input.changedAfter === 'cursor-7' ? 'cursor-11' : undefined,
        more: false,
        reset: false,
      }),
    },
  })
  const changed = await store.read({
    read: 'rulings',
    kind: 'all',
    changedAfter: 'cursor-7',
  })
  expect(changed).toMatchObject({ cursor: 'cursor-11', more: false, reset: false })
  expect(changed.items).toHaveLength(1)
  expect(field(changed.items[0]!, 'record_id')).toBe(WORKFLOW_QUESTION_ID)
  await expect(store.read({ read: 'waiting', changedAfter: 'cursor-7' })).rejects.toThrow(
    'use the rulings read',
  )
  database.close()
})

test('record ask pushes its run first and enriches live, stale, and absent sessions', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  const events: string[] = []
  const runId = newRecordId()
  const question = snapshot({ runId, workflowCursorRecordId: null, askedVia: 'live' })
  database
    .query('INSERT INTO session_seen(session_id,last_seen) VALUES (?,?),(?,?)')
    .run(
      'live-session',
      new Date().toISOString(),
      'stale-session',
      new Date(Date.now() - SESSION_LIVE_MS - 1_000).toISOString(),
    )
  const store = recordQuestionStore({
    database,
    destinationSpaceId: newRecordId(),
    pushRun: async (id) => {
      events.push(`push:${id}`)
    },
    client: {
      writeQuestion: async () => {
        events.push('write')
        return { id: question.id, number: 1, revision: 1 }
      },
      readQuestions: async () => ({
        items: [
          { id: question.id, run_id: runId, session_id: 'live-session' },
          { id: newRecordId(), run_id: runId, session_id: 'stale-session' },
          { id: newRecordId(), run_id: runId, session_id: 'missing-session' },
        ],
      }),
    },
  })
  await store.write('ask', body(question))
  expect(events).toEqual([`push:${runId}`, 'write'])
  expect(
    (await store.read({ read: 'inbox' })).items.map((row) => field(row, 'session_recent')),
  ).toEqual([1, 0, 0])
  database.close()
})
