import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { RefusalError } from '../refusal-error.ts'
import {
  decideHostedRowRelease,
  type HostedRowIds,
  hostedRowReleaseMissingDetail,
  HOSTED_ROW_RELEASE_SHOWN_IDS,
  HOSTED_ROW_TABLES,
  releaseHostedRowsAfterUpdate,
} from './hosted-row-release.ts'
import { migratedTestDatabase } from './test-database.fixture.ts'

function rowIds(
  values: Partial<Record<(typeof HOSTED_ROW_TABLES)[number], string[]>>,
): HostedRowIds {
  return Object.fromEntries(
    HOSTED_ROW_TABLES.map((table) => [table, new Set(values[table] ?? [])]),
  ) as HostedRowIds
}

test('hosted row release does nothing when every local set is empty', () => {
  expect(decideHostedRowRelease(rowIds({}), rowIds({}))).toEqual({ kind: 'nothing' })
})

test('hosted row release returns every local id when all are present', () => {
  const local = rowIds({ task_flow: ['flow'], workflow_cursor: ['stage'] })
  expect(decideHostedRowRelease(local, local)).toEqual({ kind: 'release', ids: local })
})

test('hosted row release returns missing ids by table', () => {
  const local = rowIds({ question: ['present', 'missing'], question_mutation_audit: ['audit'] })
  const decision = decideHostedRowRelease(local, rowIds({ question: ['present'] }))
  expect(decision).toEqual({
    kind: 'refuse',
    missing: rowIds({ question: ['missing'], question_mutation_audit: ['audit'] }),
  })
})

test('hosted row release missing detail bounds each table and reports the omitted count', () => {
  const questionIds = Array.from(
    { length: HOSTED_ROW_RELEASE_SHOWN_IDS + 2 },
    (_, index) => `question-${index + 1}`,
  )
  expect(
    hostedRowReleaseMissingDetail(
      rowIds({ question: questionIds, task_flow: ['flow-1', 'flow-2'] }),
    ),
  ).toBe(
    'question: question-1, question-2, question-3, question-4, question-5, and 2 more; task_flow: flow-1, flow-2',
  )
})

const at = '2026-11-18T12:00:00.000Z'

function seedReleaseRows(database: Database, bound = true): HostedRowIds {
  database.exec('PRAGMA foreign_keys=OFF')
  const ids = rowIds(Object.fromEntries(HOSTED_ROW_TABLES.map((table) => [table, [newRecordId()]])))
  const id = (table: (typeof HOSTED_ROW_TABLES)[number]) => [...ids[table]][0]!
  const projectId = newRecordId()
  const machineId = newRecordId()
  database
    .query('INSERT INTO project(record_id,name,path,canon,settings) VALUES (?,?,?,?,?)')
    .run(projectId, 'release-fixture', '/tmp/release-fixture', 0, '{"trunk":"main"}')
  database
    .query(
      `INSERT INTO task_flow
       (record_id,project_record_id,state,created_at,updated_at,opening_machine_id,updated_machine_id,revision)
       VALUES (?,?,?,?,?,?,?,1)`,
    )
    .run(id('task_flow'), projectId, 'done', at, at, machineId, machineId)
  database
    .query(
      `INSERT INTO workflow_cursor
       (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
        workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,
        total_steps,created_at,updated_at,enforcement,task_flow_record_id,opened_machine_id,
        last_advanced_machine_id,revision)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    )
    .run(
      id('workflow_cursor'),
      1,
      'release-fixture',
      projectId,
      'explore',
      'default',
      '',
      'release',
      newRecordId(),
      newRecordId(),
      '{}',
      0,
      'done',
      'done',
      '[]',
      1,
      at,
      at,
      'note-only',
      id('task_flow'),
      machineId,
      machineId,
    )
  database
    .query('UPDATE task_flow SET open_stage_cursor_record_id=? WHERE record_id=?')
    .run(id('workflow_cursor'), id('task_flow'))
  database
    .query(
      `INSERT INTO workflow_obligation
       (record_id,cursor_record_id,step_ordinal,step_slug,floor,reason,created_at)
       VALUES (?,?,0,'done','recorded-artifact','proof',?)`,
    )
    .run(id('workflow_obligation'), id('workflow_cursor'), at)
  database
    .query(
      `INSERT INTO workflow_step_text
       (record_id,cursor_record_id,step_ordinal,step_slug,body,created_at)
       VALUES (?,?,0,'done','proof',?)`,
    )
    .run(id('workflow_step_text'), id('workflow_cursor'), at)
  database
    .query(
      `INSERT INTO workflow_text_copy
       (record_id,workflow_text_record_id,cursor_record_id,task_document_reference,copied_at)
       VALUES (?,?,?,?,?)`,
    )
    .run(
      id('workflow_text_copy'),
      id('workflow_step_text'),
      id('workflow_cursor'),
      'task:DEV-2402/proof',
      at,
    )
  database
    .query(
      `INSERT INTO question
       (record_id,number,workflow_cursor_record_id,asked_at,question,revision,kind)
       VALUES (?,1,?,?,?,1,'text')`,
    )
    .run(id('question'), id('workflow_cursor'), at, 'Release?')
  database
    .query(
      `INSERT INTO question_mutation_audit(record_id,question_record_id,action,at)
       VALUES (?,?,'rule',?)`,
    )
    .run(id('question_mutation_audit'), id('question'), at)
  if (bound)
    database
      .query(
        `INSERT INTO record_install_binding(id,bound_at,record_origin)
         VALUES (1,?,'https://record.example.test')`,
      )
      .run(at)
  database.exec('PRAGMA foreign_keys=ON')
  return ids
}

function adapterDependencies(
  database: Database,
  presence: NonNullable<Parameters<typeof releaseHostedRowsAfterUpdate>[1]>['presence'],
) {
  return {
    withDatabase: <T>(action: (value: Database) => T) => action(database),
    presence,
  }
}

function tableCounts(database: Database): Record<string, number> {
  return Object.fromEntries(
    HOSTED_ROW_TABLES.map((table) => [
      table,
      database.query<{ count: number }, []>(`SELECT count(*) count FROM ${table}`).get()!.count,
    ]),
  )
}

test('hosted row release deletes every verified table and a second run makes no presence call', async () => {
  const database = migratedTestDatabase()
  const expected = seedReleaseRows(database)
  const calls: unknown[] = []
  const dependencies = adapterDependencies(database, async (input) => {
    calls.push(input)
    return input
  })
  const output: string[] = []
  await releaseHostedRowsAfterUpdate({ log: (line) => output.push(line) }, dependencies)
  await releaseHostedRowsAfterUpdate({ log: (line) => output.push(line) }, dependencies)
  expect(calls).toHaveLength(1)
  expect(tableCounts(database)).toEqual(
    Object.fromEntries(HOSTED_ROW_TABLES.map((table) => [table, 0])),
  )
  expect(output).toEqual([
    'released local workflow history now on the record: 7 rows across 7 tables',
  ])
  expect([...expected.task_flow]).toHaveLength(1)
  expect([...expected.workflow_cursor]).toHaveLength(1)
  database.close()
})

test('hosted row release refuses one missing id without deleting anything', async () => {
  const database = migratedTestDatabase()
  const ids = seedReleaseRows(database)
  const missingQuestion = [...ids.question][0]!
  const before = tableCounts(database)
  const run = releaseHostedRowsAfterUpdate(
    { log: () => {} },
    adapterDependencies(database, async (input) => ({ ...input, questionIds: [] })),
  )
  await expect(run).rejects.toBeInstanceOf(RefusalError)
  await expect(run).rejects.toThrow(`question: ${missingQuestion}`)
  await expect(run).rejects.toThrow('cleared by: bottega record sign-in')
  expect(tableCounts(database)).toEqual(before)
  database.close()
})

test('hosted row release does nothing for an unbound store', async () => {
  const database = migratedTestDatabase()
  seedReleaseRows(database, false)
  let presenceCalls = 0
  const before = tableCounts(database)
  await releaseHostedRowsAfterUpdate(
    { log: () => {} },
    adapterDependencies(database, async (input) => {
      presenceCalls += 1
      return input
    }),
  )
  expect(presenceCalls).toBe(0)
  expect(tableCounts(database)).toEqual(before)
  database.close()
})

test('hosted row release turns a presence failure into a refusal without deleting', async () => {
  const database = migratedTestDatabase()
  seedReleaseRows(database)
  const before = tableCounts(database)
  const run = releaseHostedRowsAfterUpdate(
    { log: () => {} },
    adapterDependencies(database, async () => {
      throw new Error('record unavailable')
    }),
  )
  await expect(run).rejects.toThrow(
    'local workflow history presence could not be verified; nothing was released: record unavailable',
  )
  await expect(run).rejects.toThrow('cleared by: bottega record sign-in')
  expect(tableCounts(database)).toEqual(before)
  database.close()
})
