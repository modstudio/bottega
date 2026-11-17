import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { SESSION_LIVE_MS } from '../../../shared/session-liveness.ts'
import { installRecordApiClient } from '../../test/fixtures/record-api.ts'
import { guardHostedTables } from '../database/hosted-table-guard.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { RecordApiClient } from '../record/record-api-client.ts'
import type { QuestionWriteBody } from '../record/record-question-contract.ts'
import { QUESTION_JSON_FIELDS } from '../record/record-question-contract.ts'
import {
  clearQuestionDeliveryPending,
  markQuestionDeliveryPending,
  pendingQuestionIds,
} from '../run/question-delivery-pending.ts'
import {
  type QuestionRunPusher,
  registerQuestionRunPusher,
  resolveQuestionRunPusher,
} from './question-run-pusher.ts'
import { questionStore } from './question-store.ts'
import { RecordQuestionStore } from './question-store-record.ts'
import type { QuestionStore } from './question-store-types.ts'

const STAMP = '2026-11-15T12:00:00.000Z'
const PROJECT_ID = '00000000-0000-4000-8000-000000000101'
const TASK_ID = '00000000-0000-4000-8000-000000000102'
const CURSOR_ID = '00000000-0000-4000-8000-000000000103'
const RUN_ID = '00000000-0000-4000-8000-000000000104'
const WORKFLOW_QUESTION_ID = '00000000-0000-4000-8000-000000000105'
const RUN_QUESTION_ID = '00000000-0000-4000-8000-000000000106'
const EXCLUDED_QUESTION_ID = '00000000-0000-4000-8000-000000000108'
const SPACE_ID = '00000000-0000-4000-8000-000000000109'
const OTHER_SPACE_ID = '00000000-0000-4000-8000-000000000110'
let pushedRuns: string[]
let previousQuestionRunPusher: QuestionRunPusher

beforeEach(() => {
  previousQuestionRunPusher = resolveQuestionRunPusher()
  pushedRuns = []
  registerQuestionRunPusher(async (_database, runId) => {
    pushedRuns.push(runId)
  })
})

afterEach(() => {
  registerQuestionRunPusher(previousQuestionRunPusher)
})
type QuestionSnapshot = QuestionWriteBody['question']
const field = (row: object, key: string): unknown => (row as Record<string, unknown>)[key]
const whoami = async () => ({
  user: { id: newRecordId() },
  activeSpaceId: SPACE_ID,
  personalSpaceId: SPACE_ID,
  memberships: [{ space_id: SPACE_ID, name: 'Fixture', slug: 'fixture', permission: 'write' }],
})

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
    .run(PROJECT_ID, 'question-fixture', '/fixture', 'bun', '{"space":"fixture"}')
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

async function questionStoreContract(
  store: QuestionStore,
  database: Database,
  options: { supportsByNumber: boolean },
) {
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
  expect(first).toMatchObject({ id: workflow.id, revision: 1, applied: true })
  expect(await store.write('ask', ask)).toEqual({ ...first, applied: false })

  const waiting = (await store.read({ read: 'waiting' })).items
  expect(waiting).toHaveLength(1)
  expect(waiting[0]).toMatchObject({
    workflow_cursor_record_id: CURSOR_ID,
    question_record_id: workflow.id,
    project: 'question-fixture',
  })
  const open = (await store.read({ read: 'open-for-session', sessionId: 'owner-session' })).items
  expect(open[0]).toMatchObject({ record_id: CURSOR_ID, open_question_record_id: workflow.id })
  expect((await store.read({ read: 'max-number' })).items).toEqual([{ number: 1 }])
  if (options.supportsByNumber)
    expect((await store.read({ read: 'by-number', number: 1 })).items[0]).toMatchObject({
      record_id: workflow.id,
    })
  expect(
    (await store.read({ read: 'open-for-cursors', workflowCursorRecordIds: [CURSOR_ID] })).items,
  ).toEqual([{ workflow_cursor_record_id: CURSOR_ID, number: 1 }])

  const run = snapshot({
    id: RUN_QUESTION_ID,
    runId: RUN_ID,
    workflowCursorRecordId: null,
    workflowTaskId: TASK_ID,
    askedVia: 'live',
  })
  await store.write('ask', body(run))
  expect((await store.read({ read: 'max-number' })).items).toEqual([{ number: 2 }])
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

test('SQLite and record question adapters satisfy their shared read and write contract', async () => {
  const local = migratedTestDatabase()
  const hosted = migratedTestDatabase()
  seedOwners(local)
  seedOwners(hosted)
  const hostedStore = questionStore(hosted)
  await questionStoreContract(questionStore(local), local, { supportsByNumber: true })
  await questionStoreContract(
    new RecordQuestionStore({
      database: local,
      client: {
        whoami,
        readQuestions: async (input) =>
          (await hostedStore.read(input)) as { items: Record<string, unknown>[] },
        writeQuestion: (intent, input) => hostedStore.write(intent, input),
      },
    }),
    hosted,
    { supportsByNumber: false },
  )
  local.close()
  hosted.close()
})

test.each(QUESTION_JSON_FIELDS)('SQLite question writes refuse string-valued %s', async (field) => {
  const database = migratedTestDatabase()
  seedOwners(database)
  const question = snapshot()
  ;(question as unknown as Record<string, unknown>)[field] = '[]'
  await expect(questionStore(database).write('ask', body(question))).rejects.toThrow(field)
  database.close()
})

test('only the record adapter passes a rulings feed cursor through', async () => {
  const database = migratedTestDatabase()
  await expect(
    questionStore(database).read({ read: 'rulings', kind: 'all', changedAfter: 'cursor-7' }),
  ).rejects.toThrow('changedAfter is served only on a hosted install')
  const store = new RecordQuestionStore({
    database,
    client: {
      whoami,
      readQuestions: async (_input) => ({
        items: [{ number: 1, record_id: WORKFLOW_QUESTION_ID }],
        cursor: 'cursor-11',
        more: false,
        reset: false,
      }),
    },
  })
  const changed = await store.read({
    read: 'rulings',
    kind: 'all',
    changedAfter: '0',
  })
  expect(changed.cursor).toBeString()
  expect(changed.items).toHaveLength(1)
  expect(field(changed.items[0]!, 'record_id')).toBe(WORKFLOW_QUESTION_ID)
  await expect(store.read({ read: 'waiting', changedAfter: 'cursor-7' })).rejects.toThrow(
    'use the rulings read',
  )
  database.close()
})

test('record question reads refuse a bare number before making a client request', async () => {
  const database = migratedTestDatabase()
  let requests = 0
  const store = new RecordQuestionStore({
    database,
    client: {
      whoami: async () => {
        requests += 1
        return whoami()
      },
      readQuestions: async () => {
        requests += 1
        return { items: [] }
      },
    },
  })

  await expect(store.read({ read: 'by-number', number: 7 })).rejects.toThrow(
    'question numbers are unique only within a record space; read the question by id or by cursor, then retry',
  )
  expect(requests).toBe(0)
  database.close()
})

test('record inbox paging advances independently across every reachable space', async () => {
  const database = migratedTestDatabase()
  const rows = {
    [SPACE_ID]: [newRecordId(), newRecordId(), newRecordId()],
    [OTHER_SPACE_ID]: [newRecordId(), newRecordId()],
  }
  const store = new RecordQuestionStore({
    database,
    client: {
      whoami: async () => ({
        ...(await whoami()),
        memberships: [
          { space_id: SPACE_ID, name: 'Fixture', slug: 'fixture', permission: 'write' },
          { space_id: OTHER_SPACE_ID, name: 'Other', slug: 'other', permission: 'write' },
        ],
      }),
      readQuestions: async (input, destination) => {
        const values = rows[destination!.destinationSpaceId as keyof typeof rows] ?? []
        const offset = Number(input.changedAfter ?? 0)
        const page = values.slice(offset, offset + (input.limit ?? values.length))
        return {
          items: page.map((id) => ({ record_id: id })),
          cursor: String(offset + page.length),
          more: offset + page.length < values.length,
        }
      },
    },
  })
  const seen: string[] = []
  let changedAfter: string | undefined
  let more = true
  while (more) {
    const page = await store.read({ read: 'inbox', limit: 1, changedAfter })
    seen.push(...page.items.map((row) => String(field(row, 'record_id'))))
    changedAfter = page.cursor
    more = page.more === true
  }
  expect(seen.sort()).toEqual([...rows[SPACE_ID], ...rows[OTHER_SPACE_ID]].sort())
  expect(new Set(seen).size).toBe(seen.length)
  database.close()
})

function twoSpaceStore(
  database: ReturnType<typeof migratedTestDatabase>,
  rows: Record<string, Array<string | Record<string, unknown>>>,
) {
  const written: string[] = []
  const store = new RecordQuestionStore({
    database,
    client: {
      whoami: async () => ({
        ...(await whoami()),
        memberships: [
          { space_id: SPACE_ID, name: 'Fixture', slug: 'fixture', permission: 'write' },
          { space_id: OTHER_SPACE_ID, name: 'Other', slug: 'other', permission: 'write' },
        ],
      }),
      readQuestions: async (_input, destination) => ({
        items: (rows[destination?.destinationSpaceId ?? ''] ?? []).map((row) =>
          typeof row === 'string' ? { record_id: row } : row,
        ),
      }),
      writeQuestion: async (_intent, input, destination) => {
        written.push(destination.destinationSpaceId)
        return { id: input.question.id, number: 1, revision: 2, applied: true }
      },
    },
  })
  return { store, written }
}

test('a cursor or run whose questions span record spaces reads every one of them', async () => {
  const database = migratedTestDatabase()
  seedOwners(database)
  const earlier = newRecordId()
  const later = newRecordId()
  const { store, written } = twoSpaceStore(database, {
    [SPACE_ID]: [later],
    [OTHER_SPACE_ID]: [earlier],
  })
  const forCursor = await store.read({ read: 'for-cursor', workflowCursorRecordId: CURSOR_ID })
  expect(forCursor.items.map((row) => String(field(row, 'record_id'))).sort()).toEqual(
    [earlier, later].sort(),
  )
  const forRun = await store.read({ read: 'for-run', runId: newRecordId() })
  expect(forRun.items).toHaveLength(2)
  await store.write(
    'answer',
    body({ ...snapshot(), id: earlier, revision: 2, answer: 'Yes' }, 'answer'),
  )
  expect(written).toEqual([OTHER_SPACE_ID])
  database.close()
})

test('merged questions follow asking order, because numbers repeat across spaces', async () => {
  const database = migratedTestDatabase()
  const { store } = twoSpaceStore(database, {
    [SPACE_ID]: [{ record_id: 'project-new', number: 12, asked_at: '2026-11-17T05:00:00Z' }],
    [OTHER_SPACE_ID]: [
      { record_id: 'personal-old', number: 6464, asked_at: '2026-11-16T05:00:00Z' },
    ],
  })
  const read = await store.read({ read: 'for-cursor', workflowCursorRecordId: CURSOR_ID })
  expect(read.items.map((row) => field(row, 'record_id'))).toEqual(['personal-old', 'project-new'])
  database.close()
})

test('one question id held in two record spaces is refused', async () => {
  const database = migratedTestDatabase()
  const duplicated = newRecordId()
  const { store } = twoSpaceStore(database, {
    [SPACE_ID]: [duplicated],
    [OTHER_SPACE_ID]: [duplicated],
  })
  await expect(
    store.read({ read: 'for-cursor', workflowCursorRecordId: CURSOR_ID }),
  ).rejects.toThrow('more than one record space')
  await expect(store.read({ read: 'by-id', ids: [duplicated] })).rejects.toThrow(
    'more than one record space',
  )
  database.close()
})

test('a reused record store retries identity after a failed read', async () => {
  const database = migratedTestDatabase()
  let identityReads = 0
  const store = new RecordQuestionStore({
    database,
    client: {
      whoami: async () => {
        identityReads += 1
        if (identityReads === 1) throw new Error('record API unavailable')
        return whoami()
      },
      readQuestions: async () => ({ items: [], more: false }),
    },
  })
  await expect(store.read({ read: 'inbox' })).rejects.toThrow('record API unavailable')
  expect((await store.read({ read: 'inbox' })).items).toEqual([])
  expect(identityReads).toBe(2)
  database.close()
})

test('record mutations write back to the space holding the question', async () => {
  const database = migratedTestDatabase()
  seedOwners(database)
  const question = snapshot()
  let writtenSpace: string | undefined
  const store = new RecordQuestionStore({
    database,
    client: {
      whoami: async () => ({
        ...(await whoami()),
        memberships: [
          { space_id: SPACE_ID, name: 'Fixture', slug: 'fixture', permission: 'write' },
          { space_id: OTHER_SPACE_ID, name: 'Other', slug: 'other', permission: 'write' },
        ],
      }),
      readQuestions: async (input, destination) => ({
        items:
          input.read === 'by-id' && destination!.destinationSpaceId === OTHER_SPACE_ID
            ? [{ record_id: question.id }]
            : [],
      }),
      writeQuestion: async (_intent, input, destination) => {
        writtenSpace = destination.destinationSpaceId
        return { id: input.question.id, number: 1, revision: 2, applied: true }
      },
    },
  })
  await store.write('answer', body({ ...question, revision: 2, answer: 'Yes' }, 'answer'))
  expect(writtenSpace).toBe(OTHER_SPACE_ID)
  database.close()
})

test('SQLite question writes report a lost revision race without replacing the winner', async () => {
  const database = migratedTestDatabase()
  seedOwners(database)
  const store = questionStore(database)
  const original = snapshot({ id: WORKFLOW_QUESTION_ID })
  await store.write('ask', body(original))
  const first = { ...original, revision: 2, question: 'First mutation wins' }
  const second = { ...original, revision: 2, question: 'Second mutation loses' }
  expect(await store.write('link', body(first, 'link'))).toMatchObject({ applied: true })
  expect(await store.write('link', body(second, 'link'))).toMatchObject({ applied: false })
  expect((await store.read({ read: 'by-id', ids: [original.id] })).items[0]).toMatchObject({
    question: 'First mutation wins',
    revision: 2,
  })
  database.close()
})

test('record ask pushes its run first and enriches live, stale, and absent sessions', async () => {
  const database = migratedTestDatabase()
  seedOwners(database)
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
  const store = new RecordQuestionStore({
    database,
    client: {
      whoami,
      writeQuestion: async () => {
        events.push('write')
        return { id: question.id, number: 1, revision: 1, applied: true }
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
  expect(pushedRuns).toEqual([runId])
  expect(events).toEqual(['write'])
  expect(
    (await store.read({ read: 'inbox' })).items.map((row) => field(row, 'session_recent')),
  ).toEqual([1, 0, 0])
  database.close()
})

test('record detail reads enrich machine-owned run and project fields locally', async () => {
  const database = migratedTestDatabase()
  seedOwners(database)
  database.query('UPDATE run SET pid=?,cwd=? WHERE record_id=?').run(4321, '/local-run', RUN_ID)
  const absentOwnerId = newRecordId()
  const unregisteredRepoOwnerId = newRecordId()
  const store = new RecordQuestionStore({
    database,
    client: {
      whoami,
      readQuestions: async () => ({
        items: [
          { record_id: RUN_QUESTION_ID, owner_id: RUN_ID, repo: 'question-fixture' },
          { record_id: newRecordId(), owner_id: absentOwnerId, repo: 'question-fixture' },
          { record_id: newRecordId(), owner_id: unregisteredRepoOwnerId, repo: 'unregistered' },
        ],
      }),
    },
  })
  const rows = (await store.read({ read: 'by-id', ids: [RUN_QUESTION_ID, newRecordId()] })).items
  expect(rows[0]).toMatchObject({ owner_pid: 4321, cwd: '/local-run', project_path: '/fixture' })
  expect(rows[1]).toMatchObject({ owner_pid: null, cwd: '/fixture', project_path: '/fixture' })
  expect(rows[2]).toMatchObject({ owner_pid: null, cwd: null, project_path: null })
  database.close()
})

test('hosted question selection and pending delivery never touch the local question table', async () => {
  const database = migratedTestDatabase()
  seedOwners(database)
  const guarded = guardHostedTables(database, ['question'])
  const rows = new Map<string, QuestionSnapshot>()
  const client = {
    whoami,
    writeQuestion: async (_intent: string, input: QuestionWriteBody) => {
      rows.set(input.question.id, input.question)
      return { id: input.question.id, number: 1, revision: input.question.revision, applied: true }
    },
    readQuestions: async (input: { read: string; ids?: string[] }) => ({
      items:
        input.read === 'by-id'
          ? (input.ids ?? []).flatMap((id) => (rows.has(id) ? [rows.get(id)!] : []))
          : [...rows.values()],
      cursor: input.read === 'rulings' ? 'record-cursor' : undefined,
    }),
  } as unknown as RecordApiClient
  const previous = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient(client)
  try {
    const store = questionStore(guarded)
    const asked = snapshot({ id: newRecordId(), runId: null })
    await store.write('ask', body(asked))
    await store.write('answer', body({ ...asked, revision: 2, answer: 'Yes' }, 'answer'))
    expect((await store.read({ read: 'inbox' })).items).toHaveLength(1)
    expect((await store.read({ read: 'waiting' })).items).toHaveLength(1)
    expect((await store.read({ read: 'rulings', kind: 'all' })).items).toHaveLength(1)
    markQuestionDeliveryPending(guarded, asked.id, RUN_ID, STAMP)
    expect(pendingQuestionIds(guarded, { runIds: [RUN_ID] })).toEqual([asked.id])
    expect(clearQuestionDeliveryPending(guarded, [asked.id])).toBe(1)
  } finally {
    installRecordApiClient(null)
    if (previous === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = previous
    database.close()
  }
})
