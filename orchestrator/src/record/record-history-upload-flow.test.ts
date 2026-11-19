import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { ProjectAdoptionResult } from '../project/project-relink.ts'
import type { RecordApiClient } from './record-api-client.ts'
import { RecordApiRequestError } from './record-api-client-response.ts'
import {
  HISTORY_UPLOAD_FAILURE_BOUND,
  uploadLocalWorkflowHistory,
  uploadMissingWorkflowHistory,
} from './record-history-upload.ts'

const at = '2026-11-18T01:00:00.000Z'
const absentPresence = async () => ({
  obligationIds: [],
  textIds: [],
  textCopyIds: [],
  questionAuditIds: [],
  questionIds: [],
  stageIds: [],
  flowIds: [],
  questionAuditIdentities: [],
})
const destination = async () => ({ destinationSpaceId: 'space' })
const handle =
  (database: Database) =>
  async <T>(action: (value: Database) => Promise<T>) =>
    action(database)

function bind(database: Database) {
  database
    .query(
      "INSERT INTO record_install_binding(id,bound_at,record_origin) VALUES (1,?,'https://record.test')",
    )
    .run(at)
}
function project(database: Database, name: string) {
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
function flow(database: Database, projectId: string) {
  const id = newRecordId(),
    machine = newRecordId()
  database
    .query(
      `INSERT INTO task_flow (record_id,project_record_id,state,created_at,updated_at,opening_machine_id,updated_machine_id,revision) VALUES (?,?,'done',?,?,?,?,1)`,
    )
    .run(id, projectId, at, at, machine, machine)
  return id
}
function stage(
  database: Database,
  projectName: string,
  projectId: string,
  flowId: string,
  number: number,
) {
  const id = newRecordId(),
    machine = newRecordId()
  database
    .query(
      `INSERT INTO workflow_cursor (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,total_steps,created_at,updated_at,enforcement,task_flow_record_id,opened_machine_id,last_advanced_machine_id,revision) VALUES (?,?,?,?,'explore','default','',?,?,?,?,0,'start','done','[]',1,?,?,'note-only',?,?,?,1)`,
    )
    .run(
      id,
      number,
      projectName,
      projectId,
      String(number),
      newRecordId(),
      newRecordId(),
      '{}',
      at,
      at,
      flowId,
      machine,
      machine,
    )
  return id
}
function question(database: Database, cursorId: string, number: number) {
  const id = newRecordId()
  database
    .query(
      "INSERT INTO question(record_id,number,workflow_cursor_record_id,asked_at,question,revision,kind) VALUES (?,?,?,?,?,1,'text')",
    )
    .run(id, number, cursorId, at, 'Continue?')
  database
    .query(
      "INSERT INTO question_mutation_audit(record_id,question_record_id,action,at) VALUES (?,?,'rule',?)",
    )
    .run(newRecordId(), id, at)
  return id
}
function client(
  importTaskFlow: NonNullable<RecordApiClient['importTaskFlow']>,
  importQuestion: NonNullable<RecordApiClient['importQuestion']>,
): RecordApiClient {
  return {
    readTaskFlowPresence: absentPresence,
    importTaskFlow,
    importQuestion,
  } as unknown as RecordApiClient
}
function adoption(name: string): ProjectAdoptionResult {
  const id = newRecordId()
  return { name, oldId: id, newId: id, status: 'already-linked', rewritten: {}, retried: 0 }
}

test('stale flow refusals remain failures and are not held', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  const projectId = project(database, 'stale-flow'),
    flowId = flow(database, projectId)
  stage(database, 'stale-flow', projectId, flowId, 302)
  bind(database)
  let imports = 0
  const record = client(
    async () => {
      imports += 1
      throw new RecordApiRequestError(
        'stale flow',
        'conflict',
        409,
        null,
        false,
        null,
        'stale-revision',
      )
    },
    async (input) => ({ id: input.question.id, number: 1, revision: 1, applied: true }),
  )
  const first = await uploadMissingWorkflowHistory(record, destination, handle(database))
  await uploadMissingWorkflowHistory(record, destination, handle(database))
  expect(first.failed).toBe(1)
  expect(first.lines).toEqual([`workflow history task flow ${flowId} failed: stale flow`])
  expect(imports).toBe(2)
  database.close()
})

test('a full flow failure bound does not starve questions in a later project', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  const first = project(database, 'a-flow-bound')
  for (let index = 0; index < HISTORY_UPLOAD_FAILURE_BOUND + 2; index += 1)
    stage(database, 'a-flow-bound', first, flow(database, first), 400 + index)
  const later = project(database, 'z-question'),
    laterFlow = flow(database, later)
  const questionId = question(database, stage(database, 'z-question', later, laterFlow, 500), 500)
  bind(database)
  let flowImports = 0
  const questionImports: string[] = []
  const record = client(
    async () => {
      flowImports += 1
      throw new Error('flow unavailable')
    },
    async (input) => {
      questionImports.push(input.question.id)
      return { id: input.question.id, number: 500, revision: 1, applied: true }
    },
  )
  const result = await uploadMissingWorkflowHistory(record, destination, handle(database))
  expect(flowImports).toBe(HISTORY_UPLOAD_FAILURE_BOUND)
  expect(questionImports).toEqual([questionId])
  expect(result.lines).toContain(
    `workflow history flow upload stopped after ${HISTORY_UPLOAD_FAILURE_BOUND} failures; the rest waits for the next sync`,
  )
  database.close()
})

test('sign-in holds an already-existing flow and continues importing the rest', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  const projectId = project(database, 'sign-in-held-flow'),
    held = flow(database, projectId),
    accepted = flow(database, projectId)
  stage(database, 'sign-in-held-flow', projectId, held, 601)
  stage(database, 'sign-in-held-flow', projectId, accepted, 602)
  const imported: string[] = []
  const record = client(
    async (input) => {
      imported.push(input.flow.id)
      if (input.flow.id === held)
        throw new RecordApiRequestError(
          'different flow',
          'conflict',
          409,
          null,
          false,
          null,
          'already-exists',
        )
      return { revisions: {}, stages: [] }
    },
    async (input) => ({ id: input.question.id, number: 1, revision: 1, applied: true }),
  )
  await uploadLocalWorkflowHistory(
    [adoption('sign-in-held-flow')],
    { log: () => {} },
    {
      client: record,
      destination: async () => ({ destinationSpaceId: 'space' }),
      withDatabase: handle(database),
    },
  )
  expect(new Set(imported)).toEqual(new Set([held, accepted]))
  database.close()
})
