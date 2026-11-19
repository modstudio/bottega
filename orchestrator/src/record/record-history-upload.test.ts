import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { resolveStateRoot } from '../../../shared/state-directory.ts'
import { options as syncOptions } from '../../test/fixtures/record-sync.ts'
import { fakePostgres } from '../../test/fixtures/record-sync-postgres.ts'
import { guardHostedTables } from '../database/hosted-table-guard.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { ProjectAdoptionResult } from '../project/project-relink.ts'
import type { RecordApiClient } from './record-api-client.ts'
import type { RecordQuestionClient } from './record-api-client-question.ts'
import { RecordApiRequestError } from './record-api-client-response.ts'
import type { RecordTaskFlowClient } from './record-api-client-task-flow.ts'
import {
  decideHistoryUploadPass,
  HISTORY_UPLOAD_FAILURE_BOUND,
  uploadLocalWorkflowHistory,
  uploadMissingWorkflowHistory,
} from './record-history-upload.ts'
import { RECORD_QUESTION_DIFFERENT_CONTENT } from './record-question-contract.ts'
import { RECORD_TASK_FLOW_DIFFERENT_CONTENT } from './record-task-flow-write-contract.ts'
import { syncRecord } from './record-sync.ts'

const at = '2026-11-18T01:00:00.000Z'

function bind(database: Database): void {
  database
    .query(
      "INSERT INTO record_install_binding(id,bound_at,record_origin) VALUES (1,?,'https://record.test')",
    )
    .run(at)
}

function project(database: Database, name: string): string {
  const id = newRecordId()
  database
    .query('INSERT INTO project(record_id,name,path,canon,settings) VALUES (?,?,?,0,?)')
    .run(
      id,
      name,
      `/tmp/${name}`,
      JSON.stringify({ trunk: 'main', record: { space: `${name}-space` } }),
    )
  return id
}

function flow(database: Database, projectId: string, state: 'open' | 'done' = 'done'): string {
  const id = newRecordId()
  const machine = newRecordId()
  database
    .query(
      `INSERT INTO task_flow
       (record_id,project_record_id,state,created_at,updated_at,opening_machine_id,updated_machine_id,revision)
       VALUES (?,?,?,?,?,?,?,1)`,
    )
    .run(id, projectId, state, at, at, machine, machine)
  return id
}

function stage(
  database: Database,
  input: {
    project: string
    projectId: string
    number: number
    state: 'running' | 'awaiting-ruling' | 'done' | 'abandoned'
    flowId?: string
    taskId?: string
  },
): string {
  const id = newRecordId()
  const machine = newRecordId()
  database
    .query(
      `INSERT INTO workflow_cursor
       (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
        workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,
        total_steps,created_at,updated_at,enforcement,task_record_id,task_flow_record_id,
        opened_machine_id,last_advanced_machine_id,revision)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    )
    .run(
      id,
      input.number,
      input.project,
      input.projectId,
      'explore',
      'default',
      '',
      String(input.number),
      newRecordId(),
      newRecordId(),
      '{}',
      0,
      'start',
      input.state,
      '[]',
      1,
      at,
      at,
      'note-only',
      input.taskId ?? null,
      input.flowId ?? null,
      machine,
      machine,
    )
  return id
}

function question(database: Database, cursorId: string | null, number: number): string {
  const id = newRecordId()
  const runId = cursorId === null ? newRecordId() : null
  if (runId)
    database
      .query(
        `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,changed_paths,probe)
         VALUES (?,?,?,'codex','probe','sha',1,'prompt','ok','[]',1)`,
      )
      .run(runId, number, at)
  database
    .query(
      `INSERT INTO question
       (record_id,number,run_record_id,workflow_cursor_record_id,asked_at,question,revision,kind)
       VALUES (?,?,?,?,?,?,1,'text')`,
    )
    .run(id, number, runId, cursorId, at, `Question ${number}?`)
  database
    .query(
      `INSERT INTO question_mutation_audit(record_id,question_record_id,action,at)
       VALUES (?,?,?,?)`,
    )
    .run(newRecordId(), id, 'rule', at)
  return id
}

function linked(database: Database, name: string, number: number) {
  const projectId = project(database, name)
  const flowId = flow(database, projectId)
  const stageId = stage(database, {
    project: name,
    projectId,
    number,
    state: 'done',
    flowId,
  })
  question(database, stageId, number)
  return { projectId, flowId, stageId }
}

function adoption(name: string): ProjectAdoptionResult {
  const id = newRecordId()
  return {
    name,
    oldId: id,
    newId: id,
    status: 'already-linked',
    rewritten: {},
    retried: 0,
  }
}

type ImportClient = Pick<
  RecordApiClient & RecordTaskFlowClient & RecordQuestionClient,
  'importTaskFlow' | 'importQuestion' | 'readTaskFlowPresence'
>

function dependencies(database: Database, client: ImportClient) {
  const readTaskFlowPresence =
    client.readTaskFlowPresence ??
    (async () => ({
      obligationIds: [],
      textIds: [],
      textCopyIds: [],
      questionAuditIds: [],
      questionIds: [],
      stageIds: [],
      flowIds: [],
      questionAuditIdentities: [],
    }))
  return {
    client: {
      ...client,
      readTaskFlowPresence,
    },
    destination: async (name: string | null) => ({
      destinationSpaceId: name === null ? 'personal-space' : `${name}-space`,
    }),
    withDatabase: async <T>(action: (value: Database) => Promise<T>) => action(database),
  }
}

test('empty history prints only the empty upload line', async () => {
  const database = migratedTestDatabase()
  const output: string[] = []
  const client: ImportClient = {
    importTaskFlow: async () => {
      throw new Error('unexpected')
    },
    importQuestion: async () => {
      throw new Error('unexpected')
    },
  }
  await uploadLocalWorkflowHistory(
    [],
    { log: (line) => output.push(line) },
    dependencies(database, client),
  )
  expect(output).toEqual(['no local task-flow or question history to upload'])
  database.close()
})

test('two projects upload repeatably to their own spaces and preserve every local row', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  const alpha = linked(database, 'alpha', 1)
  const beta = linked(database, 'beta', 2)
  const flowNumbers = new Map([
    [alpha.stageId, 11],
    [beta.stageId, 22],
  ])
  const questionNumbers = new Map<string, number>()
  const calls: Array<{ kind: string; space: string; id: string; requestId: string }> = []
  const client: ImportClient = {
    importTaskFlow: async (input, destination) => {
      calls.push({
        kind: 'flow',
        space: destination.destinationSpaceId,
        id: input.flow.id,
        requestId: input.requestId,
      })
      return {
        revisions: Object.fromEntries(input.stages.map((row) => [row.id, row.revision])),
        stages: input.stages.map((row) => ({ id: row.id, number: flowNumbers.get(row.id)! })),
      }
    },
    importQuestion: async (input, destination) => {
      calls.push({
        kind: 'question',
        space: destination.destinationSpaceId,
        id: input.question.id,
        requestId: input.requestId,
      })
      const number = questionNumbers.get(input.question.id) ?? 30 + questionNumbers.size + 1
      questionNumbers.set(input.question.id, number)
      return { id: input.question.id, number, revision: input.question.revision, applied: true }
    },
  }
  const before = Object.fromEntries(
    ['task_flow', 'workflow_cursor', 'question', 'question_mutation_audit'].map((table) => [
      table,
      database.query<{ n: number }, []>(`SELECT count(*) n FROM ${table}`).get()!.n,
    ]),
  )
  const first: string[] = []
  const second: string[] = []
  const deps = dependencies(database, client)
  await uploadLocalWorkflowHistory(
    [adoption('alpha'), adoption('beta')],
    { log: (line) => first.push(line) },
    deps,
  )
  await uploadLocalWorkflowHistory(
    [adoption('alpha'), adoption('beta')],
    { log: (line) => second.push(line) },
    deps,
  )
  expect(calls).toHaveLength(8)
  expect(calls.map(({ kind, space }) => `${kind}:${space}`)).toEqual([
    'flow:alpha-space',
    'question:alpha-space',
    'flow:beta-space',
    'question:beta-space',
    'flow:alpha-space',
    'question:alpha-space',
    'flow:beta-space',
    'question:beta-space',
  ])
  expect(calls.slice(0, 4).map(({ requestId }) => requestId)).toEqual(
    calls.slice(4).map(({ requestId }) => requestId),
  )
  expect(first.filter((line) => line.includes(' -> '))).toEqual(
    second.filter((line) => line.includes(' -> ')),
  )
  expect(first).toContain('cursor 1 -> cursor 11')
  expect(first).toContain('cursor 2 -> cursor 22')
  expect(first.some((line) => line.startsWith('q1 -> q'))).toBeTrue()
  expect(first.some((line) => line.startsWith('q2 -> q'))).toBeTrue()
  const after = Object.fromEntries(
    Object.keys(before).map((table) => [
      table,
      database.query<{ n: number }, []>(`SELECT count(*) n FROM ${table}`).get()!.n,
    ]),
  )
  expect(after).toEqual(before)
  database.close()
})

test('an unmatched project refuses before repair or import', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  const projectId = project(database, 'unmatched')
  stage(database, { project: 'unmatched', projectId, number: 1, state: 'done' })
  let sends = 0
  const client: ImportClient = {
    importTaskFlow: async () => {
      sends++
      throw new Error('unexpected')
    },
    importQuestion: async () => {
      sends++
      throw new Error('unexpected')
    },
  }
  await expect(
    uploadLocalWorkflowHistory(
      [{ name: 'unmatched', status: 'no-namesake' }],
      { log: () => undefined },
      dependencies(database, client),
    ),
  ).rejects.toThrow(
    'local project unmatched has workflow history but did not relink in hosted space unmatched-space',
  )
  expect(sends).toBe(0)
  expect(database.query('SELECT task_flow_record_id FROM workflow_cursor').get()).toEqual({
    task_flow_record_id: null,
  })
  database.close()
})

test('repair creates one keyless flow for every stage state and is idempotent', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  const projectId = project(database, 'repair')
  const states = ['done', 'abandoned', 'running', 'awaiting-ruling'] as const
  states.forEach((state, index) => {
    stage(database, { project: 'repair', projectId, number: index + 1, state })
  })
  const client: ImportClient = {
    importTaskFlow: async (input) => ({
      revisions: Object.fromEntries(input.stages.map((row) => [row.id, row.revision])),
      stages: input.stages.map((row, index) => ({ id: row.id, number: index + 1 })),
    }),
    importQuestion: async (input) => ({
      id: input.question.id,
      number: input.question.number ?? 1,
      revision: input.question.revision,
      applied: true,
    }),
  }
  const output: string[] = []
  const deps = dependencies(database, client)
  await uploadLocalWorkflowHistory([adoption('repair')], { log: (line) => output.push(line) }, deps)
  await uploadLocalWorkflowHistory([adoption('repair')], { log: (line) => output.push(line) }, deps)
  expect(output).toContain('repaired 4 unlinked local workflow stages')
  expect(output).toContain('repaired 0 unlinked local workflow stages')
  expect(
    database
      .query(
        `SELECT cursor.state,flow.state flow_state,
                COALESCE(flow.open_stage_cursor_record_id=cursor.record_id,0) is_open
         FROM workflow_cursor cursor JOIN task_flow flow ON flow.record_id=cursor.task_flow_record_id
         ORDER BY cursor.number`,
      )
      .all(),
  ).toEqual([
    { state: 'done', flow_state: 'done', is_open: 0 },
    { state: 'abandoned', flow_state: 'dropped', is_open: 0 },
    { state: 'running', flow_state: 'open', is_open: 1 },
    { state: 'awaiting-ruling', flow_state: 'open', is_open: 1 },
  ])
  expect(database.query('SELECT count(*) n FROM task_flow').get()).toEqual({ n: 4 })
  database.close()
})

test('a keyed stage without a flow refuses before any local or hosted write', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  const projectId = project(database, 'keyed-orphan')
  stage(database, {
    project: 'keyed-orphan',
    projectId,
    number: 7,
    state: 'running',
    taskId: newRecordId(),
  })
  const before = database.serialize()
  let sends = 0
  const client: ImportClient = {
    importTaskFlow: async () => {
      sends++
      throw new Error('unexpected')
    },
    importQuestion: async () => {
      sends++
      throw new Error('unexpected')
    },
  }
  await expect(
    uploadLocalWorkflowHistory(
      [adoption('keyed-orphan')],
      { log: () => undefined },
      dependencies(database, client),
    ),
  ).rejects.toThrow(
    'cursor 7 in project keyed-orphan has a task but no task flow; ask the architect to repair that task-flow link, then sign in again',
  )
  expect(sends).toBe(0)
  expect(database.serialize()).toEqual(before)
  database.close()
})

test('projectless questions upload with audits to the personal space and are counted', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  const questionId = question(database, null, 9)
  const calls: Array<{ id: string; space: string; audits: number }> = []
  const client: ImportClient = {
    importTaskFlow: async () => {
      throw new Error('unexpected')
    },
    importQuestion: async (input, destination) => {
      calls.push({
        id: input.question.id,
        space: destination.destinationSpaceId,
        audits: input.audits.length,
      })
      return { id: input.question.id, number: 9, revision: 1, applied: true }
    },
  }
  const output: string[] = []
  await uploadLocalWorkflowHistory(
    [],
    { log: (line) => output.push(line) },
    dependencies(database, client),
  )
  expect(calls).toEqual([{ id: questionId, space: 'personal-space', audits: 1 }])
  expect(output).toContain('personal space: uploaded 1 questions')
  database.close()
})

test('sign-in skips a question whose audit is present under a different id', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  const questionId = question(database, null, 10)
  let imports = 0
  const client: ImportClient = {
    readTaskFlowPresence: async (input) => ({
      obligationIds: input.obligationIds ?? [],
      textIds: input.textIds ?? [],
      textCopyIds: input.textCopyIds ?? [],
      questionAuditIds: [],
      questionIds: input.questionIds ?? [],
      stageIds: input.stageIds ?? [],
      flowIds: input.flowIds ?? [],
      questionAuditIdentities: [{ questionId, action: 'rule', at }],
    }),
    importTaskFlow: async () => {
      throw new Error('unexpected flow import')
    },
    importQuestion: async () => {
      imports += 1
      throw new Error('unexpected question import')
    },
  }
  await uploadLocalWorkflowHistory([], { log: () => undefined }, dependencies(database, client))
  expect(imports).toBe(0)
  database.close()
})

test('a missing import capability refuses before repairing local history', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  const projectId = project(database, 'capability')
  stage(database, { project: 'capability', projectId, number: 1, state: 'done' })
  const before = database.serialize()
  await expect(
    uploadLocalWorkflowHistory(
      [adoption('capability')],
      { log: () => undefined },
      dependencies(database, {} as ImportClient),
    ),
  ).rejects.toThrow(
    'record API predates workflow history imports; release hosted-api, then sign in again',
  )
  expect(database.serialize()).toEqual(before)
  database.close()
})

test('a partial hosted failure leaves all local rows in place', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  linked(database, 'partial', 1)
  const second = flow(
    database,
    database.query<{ record_id: string }, []>('SELECT record_id FROM project').get()!.record_id,
  )
  stage(database, {
    project: 'partial',
    projectId: database.query<{ record_id: string }, []>('SELECT record_id FROM project').get()!
      .record_id,
    number: 2,
    state: 'done',
    flowId: second,
  })
  let imports = 0
  const client: ImportClient = {
    importTaskFlow: async (input) => {
      imports++
      if (imports === 2) throw new Error('host unavailable')
      return {
        revisions: {},
        stages: input.stages.map((row, index) => ({ id: row.id, number: index + 1 })),
      }
    },
    importQuestion: async (input) => ({
      id: input.question.id,
      number: input.question.number ?? 1,
      revision: input.question.revision,
      applied: true,
    }),
  }
  const before = database.serialize()
  await expect(
    uploadLocalWorkflowHistory(
      [adoption('partial')],
      { log: () => undefined },
      dependencies(database, client),
    ),
  ).rejects.toThrow('host unavailable; sign in again to retry')
  expect(database.serialize()).toEqual(before)
  database.close()
})

function syncClient(
  presence: (
    ...args: Parameters<NonNullable<RecordApiClient['readTaskFlowPresence']>>
  ) => Promise<unknown>,
  importQuestion: NonNullable<RecordApiClient['importQuestion']>,
  importTaskFlow: NonNullable<RecordApiClient['importTaskFlow']>,
): RecordApiClient {
  return {
    readTaskFlowPresence: async (...args) => {
      const result = (await presence(...args)) as Record<string, unknown>
      return {
        ...result,
        questionAuditIdentities: result.questionAuditIdentities ?? [],
      } as Awaited<ReturnType<NonNullable<RecordApiClient['readTaskFlowPresence']>>>
    },
    importQuestion,
    importTaskFlow,
  } as RecordApiClient
}

const syncDestination = async () => ({ destinationSpaceId: 'space' })
const absentPresence = async () => ({
  obligationIds: [],
  textIds: [],
  textCopyIds: [],
  questionAuditIds: [],
  questionIds: [],
  stageIds: [],
  flowIds: [],
})

const maintenanceHandle =
  (database: Database) =>
  async <T>(action: (value: Database) => Promise<T>) =>
    action(database)

test('history upload pass skips only an unchanged stored fingerprint', () => {
  const current = [{ table: 'question', count: 1, maxRowid: 2 }]
  expect(decideHistoryUploadPass({ stored: current, current })).toBe('skip')
  expect(
    decideHistoryUploadPass({
      stored: current,
      current: [{ table: 'question', count: 2, maxRowid: 3 }],
    }),
  ).toBe('upload')
  expect(decideHistoryUploadPass({ stored: null, current })).toBe('upload')
})

test('sync history does not call the network for an unbound store', async () => {
  const database = migratedTestDatabase()
  let calls = 0
  const client = syncClient(
    async (input) => {
      calls += 1
      return input
    },
    async () => {
      calls += 1
      throw new Error('unexpected')
    },
    async () => {
      calls += 1
      throw new Error('unexpected')
    },
  )
  expect(
    await uploadMissingWorkflowHistory(client, syncDestination, maintenanceHandle(database)),
  ).toEqual({
    failed: 0,
    lines: [],
    skipped: false,
  })
  expect(calls).toBe(0)
  database.close()
})

test('sync history imports one question whose audit is absent and no task flow', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  linked(database, 'sync-audit', 1)
  bind(database)
  let questions = 0
  let flows = 0
  const client = syncClient(
    async (input) => ({ ...input, questionAuditIds: [] }),
    async (input) => {
      questions += 1
      return { id: input.question.id, number: 1, revision: 1, applied: true }
    },
    async () => {
      flows += 1
      return { revisions: {}, stages: [] }
    },
  )
  expect(
    await uploadMissingWorkflowHistory(client, syncDestination, maintenanceHandle(database)),
  ).toEqual({
    failed: 0,
    lines: [],
    skipped: false,
  })
  expect({ questions, flows }).toEqual({ questions: 1, flows: 0 })
  database.close()
})

test('sync history makes no import calls when every local id is present', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  linked(database, 'sync-present', 1)
  bind(database)
  let imports = 0
  let presenceReads = 0
  const client = syncClient(
    async (input) => {
      presenceReads += 1
      return input
    },
    async (input) => {
      imports += 1
      return { id: input.question.id, number: 1, revision: 1, applied: true }
    },
    async () => {
      imports += 1
      return { revisions: {}, stages: [] }
    },
  )
  await uploadMissingWorkflowHistory(client, syncDestination, maintenanceHandle(database))
  await uploadMissingWorkflowHistory(client, syncDestination, maintenanceHandle(database))
  expect(presenceReads).toBe(1)
  expect(imports).toBe(0)
  const stageId = database
    .query<{ record_id: string }, []>('SELECT record_id FROM workflow_cursor')
    .get()!.record_id
  question(database, stageId, 2)
  await uploadMissingWorkflowHistory(client, syncDestination, maintenanceHandle(database))
  expect(presenceReads).toBe(2)
  database.close()
})

test('sync history repairs and imports one keyless flowless cursor', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  const projectId = project(database, 'sync-repair')
  const stageId = stage(database, {
    project: 'sync-repair',
    projectId,
    number: 1,
    state: 'running',
  })
  bind(database)
  const imports: Array<Parameters<NonNullable<RecordApiClient['importTaskFlow']>>[0]> = []
  const client = syncClient(
    absentPresence,
    async () => {
      throw new Error('unexpected question import')
    },
    async (input) => {
      imports.push(input)
      return { revisions: {}, stages: input.stages.map((row) => ({ id: row.id, number: 1 })) }
    },
  )
  const result = await uploadMissingWorkflowHistory(
    client,
    syncDestination,
    maintenanceHandle(database),
  )
  expect(result).toEqual({
    failed: 0,
    lines: ['repaired 1 unlinked local workflow stages'],
    skipped: false,
  })
  expect(imports).toHaveLength(1)
  expect(imports[0]!.stages.map((row) => row.id)).toEqual([stageId])
  expect(
    database
      .query<{ task_flow_record_id: string | null }, [string]>(
        'SELECT task_flow_record_id FROM workflow_cursor WHERE record_id=?',
      )
      .get(stageId)?.task_flow_record_id,
  ).toBe(imports[0]!.flow.id)
  database.close()
})

test('sync history reports a keyed flowless repair skip and still imports an absent question', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  const projectId = project(database, 'sync-keyed-orphan')
  stage(database, {
    project: 'sync-keyed-orphan',
    projectId,
    number: 7,
    state: 'running',
    taskId: newRecordId(),
  })
  question(database, null, 9)
  bind(database)
  let questions = 0
  let flows = 0
  const client = syncClient(
    absentPresence,
    async (input) => {
      questions += 1
      return { id: input.question.id, number: 9, revision: 1, applied: true }
    },
    async () => {
      flows += 1
      return { revisions: {}, stages: [] }
    },
  )
  const result = await uploadMissingWorkflowHistory(
    client,
    syncDestination,
    maintenanceHandle(database),
  )
  expect(result.failed).toBe(0)
  expect(result.lines).toEqual([
    'workflow history stage repair skipped: cursor 7 in project sync-keyed-orphan has a task but no task flow; ask the architect to repair that task-flow link, then sign in again',
  ])
  expect(result.skipped).toBe(true)
  expect({ questions, flows }).toEqual({ questions: 1, flows: 0 })
  database.close()
})

test('sync history reports one failed question import and continues to the next', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  const { stageId } = linked(database, 'sync-continue', 1)
  question(database, stageId, 2)
  bind(database)
  let calls = 0
  let presenceReads = 0
  const client = syncClient(
    async (input) => {
      presenceReads += 1
      return { ...input, questionIds: [], questionAuditIds: [] }
    },
    async (input) => {
      calls += 1
      if (calls === 1) throw new Error('first failed')
      return { id: input.question.id, number: 2, revision: 1, applied: true }
    },
    async () => ({ revisions: {}, stages: [] }),
  )
  const result = await uploadMissingWorkflowHistory(
    client,
    syncDestination,
    maintenanceHandle(database),
  )
  expect(calls).toBe(2)
  expect(result.failed).toBe(1)
  expect(result.lines[0]).toContain('first failed')
  await uploadMissingWorkflowHistory(client, syncDestination, maintenanceHandle(database))
  expect(presenceReads).toBe(2)
  database.close()
})

test('sync uses the maintenance handle for bound hosted history instead of its guarded handle', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  linked(database, 'sync-guarded', 1)
  bind(database)
  let presenceReads = 0
  const base = syncOptions(guardHostedTables(database), fakePostgres())
  const client = {
    ...base.client,
    readTaskFlowPresence: async (
      input: Parameters<NonNullable<RecordApiClient['readTaskFlowPresence']>>[0],
    ) => {
      presenceReads += 1
      return {
        obligationIds: input.obligationIds ?? [],
        textIds: input.textIds ?? [],
        textCopyIds: input.textCopyIds ?? [],
        questionAuditIds: input.questionAuditIds ?? [],
        questionIds: input.questionIds ?? [],
        stageIds: input.stageIds ?? [],
        flowIds: input.flowIds ?? [],
        questionAuditIdentities: [],
      }
    },
    importQuestion: async () => {
      throw new Error('unexpected question import')
    },
    importTaskFlow: async () => {
      throw new Error('unexpected flow import')
    },
  }
  await syncRecord({
    ...base,
    client,
    historyUploadWithDatabase: maintenanceHandle(database),
  })
  expect(presenceReads).toBe(1)
  database.close()
})

test('sync consumes audit identities from the presence reader before deciding to import', async () => {
  for (const [action, identityAt, expectedImports] of [
    ['rule', at, 0],
    ['answer', at, 1],
    ['rule', '2026-11-18T02:00:00.000Z', 1],
  ] as const) {
    const database = migratedTestDatabase()
    database.exec('PRAGMA foreign_keys=OFF')
    const questionId = question(database, null, action === 'rule' ? 81 : 82)
    bind(database)
    let imports = 0
    const client = syncClient(
      async (input) => ({
        ...input,
        questionAuditIds: [],
        questionAuditIdentities: [{ questionId, action, at: identityAt }],
      }),
      async (input) => {
        imports += 1
        return { id: input.question.id, number: 1, revision: 1, applied: true }
      },
      async () => {
        throw new Error('unexpected flow import')
      },
    )
    await uploadMissingWorkflowHistory(client, syncDestination, maintenanceHandle(database))
    expect(imports).toBe(expectedImports)
    database.close()
  }
})

test('sync archives a question held by the record with different content', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  const questionId = question(database, null, 91)
  bind(database)
  const directory = join(resolveStateRoot(process.env), 'archive', 'history-upload-conflict')
  const before = new Set(existsSync(directory) ? readdirSync(directory) : [])
  const importedIds: string[] = []
  const client = syncClient(
    absentPresence,
    async (input) => {
      importedIds.push(input.question.id)
      if (input.question.id === questionId)
        throw new Error(`question ${questionId} ${RECORD_QUESTION_DIFFERENT_CONTENT}`)
      return { id: input.question.id, number: 92, revision: 1, applied: true }
    },
    async () => ({ revisions: {}, stages: [] }),
  )
  const result = await uploadMissingWorkflowHistory(
    client,
    syncDestination,
    maintenanceHandle(database),
  )
  expect(result.failed).toBe(0)
  expect(result.lines).toHaveLength(1)
  expect(result.lines[0]).toContain(
    `1 questions held by the record with different content; local copies archived to ${directory}`,
  )
  expect(result.lines[0]).toContain(`first: ${questionId}`)
  const created = readdirSync(directory).filter((name) => !before.has(name))
  expect(created).toHaveLength(1)
  const archived = JSON.parse(readFileSync(join(directory, created[0]!), 'utf8').trim())
  expect(archived.table).toBe('question')
  expect(archived.row.record_id).toBe(questionId)
  expect(archived.row.audits).toHaveLength(1)

  question(database, null, 92)
  const second = await uploadMissingWorkflowHistory(
    client,
    syncDestination,
    maintenanceHandle(database),
  )
  expect(second.lines.some((line) => line.includes('held by the record'))).toBe(false)
  expect(importedIds.filter((id) => id === questionId)).toHaveLength(1)
  expect(readdirSync(directory).filter((name) => !before.has(name))).toEqual(created)

  await uploadLocalWorkflowHistory([], { log: () => undefined }, dependencies(database, client))
  expect(importedIds.filter((id) => id === questionId)).toHaveLength(1)
  expect(readdirSync(directory).filter((name) => !before.has(name))).toEqual(created)
  database.close()
})

test('sync stops importing after the question failure bound', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  for (let index = 0; index < HISTORY_UPLOAD_FAILURE_BOUND + 2; index += 1)
    question(database, null, 200 + index)
  bind(database)
  let calls = 0
  const client = syncClient(
    absentPresence,
    async () => {
      calls += 1
      throw new Error('generic import failure')
    },
    async () => ({ revisions: {}, stages: [] }),
  )
  const result = await uploadMissingWorkflowHistory(
    client,
    syncDestination,
    maintenanceHandle(database),
  )
  expect(calls).toBe(HISTORY_UPLOAD_FAILURE_BOUND)
  expect(result.failed).toBe(HISTORY_UPLOAD_FAILURE_BOUND)
  expect(result.lines).toContain(
    `workflow history question upload stopped after ${HISTORY_UPLOAD_FAILURE_BOUND} failures; the rest waits for the next sync`,
  )
  database.close()
})

test('sync resolves no more destinations after both upload kinds stop', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  const firstProjectId = project(database, 'a-both-bounds')
  for (let index = 0; index < HISTORY_UPLOAD_FAILURE_BOUND; index += 1) {
    const flowId = flow(database, firstProjectId)
    const stageId = stage(database, {
      project: 'a-both-bounds',
      projectId: firstProjectId,
      number: 700 + index,
      state: 'done',
      flowId,
    })
    question(database, stageId, 700 + index)
  }
  linked(database, 'z-unvisited-project', 800)
  question(database, null, 900)
  bind(database)
  const destinations: string[] = []
  let flowImports = 0
  let questionImports = 0
  const client = syncClient(
    absentPresence,
    async () => {
      questionImports += 1
      throw new Error('question unavailable')
    },
    async () => {
      flowImports += 1
      throw new Error('flow unavailable')
    },
  )
  const result = await uploadMissingWorkflowHistory(
    client,
    async (_client, owner) => {
      destinations.push(owner?.kind === 'project' ? owner.name : 'personal')
      return { destinationSpaceId: 'space' }
    },
    maintenanceHandle(database),
  )
  expect(flowImports).toBe(HISTORY_UPLOAD_FAILURE_BOUND)
  expect(questionImports).toBe(HISTORY_UPLOAD_FAILURE_BOUND)
  expect(result.failed).toBe(HISTORY_UPLOAD_FAILURE_BOUND * 2)
  expect(destinations).toEqual(['a-both-bounds'])
  database.close()
})

test('sync holds an already-existing flow once and stores the converged fingerprint', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  const projectId = project(database, 'held-flow')
  const flowId = flow(database, projectId)
  stage(database, { project: 'held-flow', projectId, number: 301, state: 'done', flowId })
  bind(database)
  const directory = join(resolveStateRoot(process.env), 'archive', 'history-upload-conflict')
  const before = new Set(existsSync(directory) ? readdirSync(directory) : [])
  let imports = 0
  const client = syncClient(
    absentPresence,
    async () => ({ id: newRecordId(), number: 1, revision: 1, applied: true }),
    async () => {
      imports += 1
      throw new RecordApiRequestError(
        `task_flow ${flowId} ${RECORD_TASK_FLOW_DIFFERENT_CONTENT}`,
        'conflict',
        409,
        null,
        false,
        null,
        'already-exists',
      )
    },
  )
  const first = await uploadMissingWorkflowHistory(
    client,
    syncDestination,
    maintenanceHandle(database),
  )
  const second = await uploadMissingWorkflowHistory(
    client,
    syncDestination,
    maintenanceHandle(database),
  )
  expect(first.failed).toBe(0)
  expect(first.lines[0]).toContain(`1 task flows held by the record with different content`)
  expect(second).toEqual({ failed: 0, lines: [], skipped: false })
  expect(imports).toBe(1)
  const created = readdirSync(directory).filter((name) => !before.has(name))
  expect(created).toHaveLength(1)
  const archived = JSON.parse(readFileSync(join(directory, created[0]!), 'utf8').trim())
  expect(archived).toMatchObject({ table: 'task_flow', row: { flow: { id: flowId } } })
  database.close()
})
