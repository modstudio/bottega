import { expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { ProjectAdoptionResult } from '../project/project-relink.ts'
import type { RecordTaskFlowClient } from './record-api-client-task-flow.ts'
import type { RecordQuestionClient } from './record-api-client-question.ts'
import { uploadLocalWorkflowHistory } from './record-sign-in-history-upload.ts'

const at = '2026-11-18T01:00:00.000Z'

function project(database: Database, name: string): string {
  const id = newRecordId()
  database
    .query('INSERT INTO project(record_id,name,path,canon,settings) VALUES (?,?,?,0,?)')
    .run(id, name, `/tmp/${name}`, JSON.stringify({ trunk: 'main', record: { space: `${name}-space` } }))
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

function question(database: Database, cursorId: string, number: number): string {
  const id = newRecordId()
  database
    .query(
      `INSERT INTO question
       (record_id,number,workflow_cursor_record_id,asked_at,question,revision,kind)
       VALUES (?,?,?,?,?,1,'text')`,
    )
    .run(id, number, cursorId, at, `Question ${number}?`)
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
  RecordTaskFlowClient & RecordQuestionClient,
  'whoami' | 'importTaskFlow' | 'importQuestion'
>

function dependencies(database: Database, client: ImportClient) {
  return {
    client,
    destination: async (name: string) => ({ destinationSpaceId: `${name}-space` }),
    withDatabase: async <T>(action: (value: Database) => Promise<T>) => action(database),
  }
}

test('two projects upload repeatably to their own spaces and preserve every local row', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  const alpha = linked(database, 'alpha', 1)
  const beta = linked(database, 'beta', 2)
  const flowNumbers = new Map([[alpha.stageId, 11], [beta.stageId, 22]])
  const questionNumbers = new Map<string, number>()
  const calls: Array<{ kind: string; space: string; id: string }> = []
  const client: ImportClient = {
    whoami: async () => ({ personalSpaceId: 'personal', memberships: [], user: {} }),
    importTaskFlow: async (input, destination) => {
      calls.push({ kind: 'flow', space: destination.destinationSpaceId, id: input.flow.id })
      return {
        revisions: Object.fromEntries(input.stages.map((row) => [row.id, row.revision])),
        stages: input.stages.map((row) => ({ id: row.id, number: flowNumbers.get(row.id)! })),
      }
    },
    importQuestion: async (input, destination) => {
      calls.push({ kind: 'question', space: destination.destinationSpaceId, id: input.question.id })
      const number = questionNumbers.get(input.question.id) ?? 30 + questionNumbers.size + 1
      questionNumbers.set(input.question.id, number)
      return { id: input.question.id, number, revision: input.question.revision, applied: true }
    },
  }
  const before = Object.fromEntries(
    ['task_flow', 'workflow_cursor', 'question', 'question_mutation_audit'].map((table) => [
      table,
      (database.query<{ n: number }, []>(`SELECT count(*) n FROM ${table}`).get()!).n,
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
      (database.query<{ n: number }, []>(`SELECT count(*) n FROM ${table}`).get()!).n,
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
    whoami: async () => ({ personalSpaceId: 'personal', memberships: [], user: {} }),
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
  states.forEach((state, index) =>
    stage(database, { project: 'repair', projectId, number: index + 1, state }),
  )
  const client: ImportClient = {
    whoami: async () => ({ personalSpaceId: 'personal', memberships: [], user: {} }),
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

test('a partial hosted failure leaves all local rows in place', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  linked(database, 'partial', 1)
  const second = flow(database, database.query<{ record_id: string }, []>('SELECT record_id FROM project').get()!.record_id)
  stage(database, {
    project: 'partial',
    projectId: database.query<{ record_id: string }, []>('SELECT record_id FROM project').get()!.record_id,
    number: 2,
    state: 'done',
    flowId: second,
  })
  let imports = 0
  const client: ImportClient = {
    whoami: async () => ({ personalSpaceId: 'personal', memberships: [], user: {} }),
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
