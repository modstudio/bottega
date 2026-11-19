import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  decideHostedRowRelease,
  HOSTED_ROW_RELEASE_ARCHIVE_KEEP,
  releaseHostedRowsAfterUpdate,
  writeHostedRowReleaseArchive,
} from './hosted-row-release.ts'
import { HOSTED_TABLES_WITHOUT_LOCAL_ACCESS } from './hosted-table-guard.ts'
import { migratedTestDatabase } from './test-database.fixture.ts'
import {
  HOSTED_ROW_TABLES,
  type HostedRowIds,
  type HostedRowReferences,
} from '../record/record-hosted-row-presence.ts'

function rowIds(
  values: Partial<Record<(typeof HOSTED_ROW_TABLES)[number], string[]>>,
): HostedRowIds {
  return {
    workflow_obligation: new Set(values.workflow_obligation ?? []),
    workflow_step_text: new Set(values.workflow_step_text ?? []),
    workflow_text_copy: new Set(values.workflow_text_copy ?? []),
    question_mutation_audit: new Set(values.question_mutation_audit ?? []),
    question: new Set(values.question ?? []),
    workflow_cursor: new Set(values.workflow_cursor ?? []),
    task_flow: new Set(values.task_flow ?? []),
  }
}

const noReferences = (): HostedRowReferences => ({
  obligationCursor: new Map(),
  stepTextCursor: new Map(),
  textCopyCursor: new Map(),
  auditQuestion: new Map(),
  questionCursor: new Map(),
  cursorFlow: new Map(),
  cursorHandoff: new Map(),
  flowOpenCursor: new Map(),
})

test('hosted row release table set matches the guarded hosted table set', () => {
  expect(new Set(HOSTED_ROW_TABLES)).toEqual(new Set(HOSTED_TABLES_WITHOUT_LOCAL_ACCESS))
})

test('hosted row release returns every local id when all are present', () => {
  const local = rowIds({ task_flow: ['flow'], workflow_cursor: ['stage'] })
  expect(decideHostedRowRelease(local, local, noReferences())).toEqual({
    deleteIds: local,
    keptTables: [],
  })
})

test('hosted row release keeps an incomplete table and its referenced parents', () => {
  const local = rowIds({ question: ['present', 'missing'], question_mutation_audit: ['audit'] })
  const refs = noReferences()
  refs.auditQuestion = new Map([['audit', 'present']])
  const decision = decideHostedRowRelease(local, rowIds({ question: ['present'] }), refs)
  expect(decision.deleteIds).toEqual(rowIds({}))
  expect(decision.keptTables).toEqual([
    { table: 'question_mutation_audit', absentIds: ['audit'] },
    { table: 'question', absentIds: ['missing'] },
  ])
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

function seedHandoffCursor(database: Database, predecessorRecordId: string, number = 2): string {
  const successorRecordId = newRecordId()
  database.exec('PRAGMA foreign_keys=OFF')
  database
    .query(
      `INSERT INTO workflow_cursor
       (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
        workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,
        total_steps,created_at,updated_at,enforcement,task_flow_record_id,opened_machine_id,
        last_advanced_machine_id,revision,handed_off_from_record_id)
       SELECT ?,?,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id || '-' || ?,
        workflow_version_record_id,catalogue_version_record_id,args,ordinal,step_slug,state,closed,
        total_steps,created_at,updated_at,enforcement,task_flow_record_id,opened_machine_id,
        last_advanced_machine_id,revision,record_id
       FROM workflow_cursor WHERE record_id=?`,
    )
    .run(successorRecordId, number, number, predecessorRecordId)
  database.exec('PRAGMA foreign_keys=ON')
  return successorRecordId
}

function adapterDependencies(
  database: Database,
  presence: NonNullable<Parameters<typeof releaseHostedRowsAfterUpdate>[1]>['presence'],
) {
  return {
    withDatabase: <T>(action: (value: Database) => T) => action(database),
    presence,
    archive: () => '/tmp/release.jsonl',
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
    'archived released local workflow history at /tmp/release.jsonl',
    'released 7 local workflow history rows now on the record',
  ])
  expect([...expected.task_flow]).toHaveLength(1)
  expect([...expected.workflow_cursor]).toHaveLength(1)
  database.close()
})

test('hosted row release deletes a verified handoff-linked cursor pair', async () => {
  const database = migratedTestDatabase()
  const ids = seedReleaseRows(database)
  const predecessorRecordId = [...ids.workflow_cursor][0]!
  const successorRecordId = seedHandoffCursor(database, predecessorRecordId)
  await releaseHostedRowsAfterUpdate(
    { log: () => {} },
    adapterDependencies(database, async (input) => {
      expect(new Set(input.stageIds)).toEqual(new Set([predecessorRecordId, successorRecordId]))
      return input
    }),
  )
  expect(database.query('SELECT record_id FROM workflow_cursor').all()).toEqual([])
  database.close()
})

test('an absent step text keeps its cursor, flow, and open-stage cursor closure', async () => {
  const database = migratedTestDatabase()
  const ids = seedReleaseRows(database)
  const textId = [...ids.workflow_step_text][0]!
  const textCursor = [...ids.workflow_cursor][0]!
  const openCursor = seedHandoffCursor(database, textCursor)
  database
    .query('UPDATE workflow_cursor SET handed_off_from_record_id=NULL WHERE record_id=?')
    .run(openCursor)
  const otherCursor = seedHandoffCursor(database, textCursor, 3)
  database
    .query('UPDATE workflow_cursor SET handed_off_from_record_id=NULL WHERE record_id IN (?,?)')
    .run(openCursor, otherCursor)
  database.query('UPDATE task_flow SET open_stage_cursor_record_id=?').run(openCursor)
  await releaseHostedRowsAfterUpdate(
    { log: () => {} },
    adapterDependencies(database, async (input) => ({ ...input, textIds: [] })),
  )
  expect(
    database
      .query<{ record_id: string }, []>('SELECT record_id FROM workflow_cursor ORDER BY record_id')
      .all()
      .map((row) => row.record_id),
  ).toEqual([openCursor, textCursor].sort())
  expect(database.query('SELECT record_id FROM workflow_step_text').all()).toEqual([
    { record_id: textId },
  ])
  expect(
    database.query('SELECT record_id FROM workflow_cursor WHERE record_id=?').get(otherCursor),
  ).toBeNull()
  database.close()
})

test('hosted row release keeps one incomplete audit table and its question', async () => {
  const database = migratedTestDatabase()
  const ids = seedReleaseRows(database)
  const missingAudit = [...ids.question_mutation_audit][0]!
  const runId = newRecordId()
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,changed_paths,probe)
       VALUES (?,99,?,'codex','probe','sha',1,'prompt','ok','[]',1)`,
    )
    .run(runId, at)
  database.query('UPDATE question SET run_record_id=?,workflow_cursor_record_id=NULL').run(runId)
  const output: string[] = []
  await releaseHostedRowsAfterUpdate(
    { log: (line) => output.push(line) },
    adapterDependencies(database, async (input) => ({ ...input, questionAuditIds: [] })),
  )
  expect(tableCounts(database)).toEqual({
    workflow_obligation: 0,
    workflow_step_text: 0,
    workflow_text_copy: 0,
    question_mutation_audit: 1,
    question: 1,
    workflow_cursor: 0,
    task_flow: 0,
  })
  expect(output).toEqual([
    'archived released local workflow history at /tmp/release.jsonl',
    `kept local question_mutation_audit: 1 ids absent from the record: ${missingAudit}; run ${PLATFORM_SLUG} record sync, then ${PLATFORM_SLUG} machine update`,
    'released 5 local workflow history rows now on the record',
  ])
  database.close()
})

test('hosted row release archives exactly the rows it deletes before removing them', async () => {
  const database = migratedTestDatabase()
  const ids = seedReleaseRows(database)
  const directory = mkdtempSync(join(tmpdir(), 'hosted-row-release-'))
  const output: string[] = []
  await releaseHostedRowsAfterUpdate(
    { log: (line) => output.push(line) },
    {
      withDatabase: <T>(action: (value: Database) => T) => action(database),
      presence: async (input) => input,
      archive: (rows) =>
        writeHostedRowReleaseArchive(rows, {
          directory,
          now: new Date('2026-11-19T12:34:56.000Z'),
        }),
    },
  )
  const archive = join(directory, readdirSync(directory)[0]!)
  const archived = readFileSync(archive, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { table: (typeof HOSTED_ROW_TABLES)[number]; row: { record_id: string } })
  expect(
    Object.fromEntries(
      HOSTED_ROW_TABLES.map((table) => [
        table,
        archived.filter((entry) => entry.table === table).map((entry) => entry.row.record_id),
      ]),
    ),
  ).toEqual(Object.fromEntries(HOSTED_ROW_TABLES.map((table) => [table, [...ids[table]]])))
  expect(tableCounts(database)).toEqual(
    Object.fromEntries(HOSTED_ROW_TABLES.map((table) => [table, 0])),
  )
  expect(output[0]).toBe(`archived released local workflow history at ${archive}`)
  database.close()
})

test('a failing hosted row release archive writer leaves every row in place', async () => {
  const database = migratedTestDatabase()
  seedReleaseRows(database)
  const before = tableCounts(database)
  const output: string[] = []
  await releaseHostedRowsAfterUpdate(
    { log: (line) => output.push(line) },
    {
      ...adapterDependencies(database, async (input) => input),
      archive: () => {
        throw new Error('disk full')
      },
    },
  )
  expect(tableCounts(database)).toEqual(before)
  expect(output).toEqual([
    'kept all releasable local workflow history: archive write failed: disk full',
  ])
  database.close()
})

test('hosted row release archive retention keeps only the newest files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hosted-row-release-retention-'))
  for (let day = 1; day <= HOSTED_ROW_RELEASE_ARCHIVE_KEEP + 2; day++)
    writeHostedRowReleaseArchive(
      [{ table: 'question', row: { record_id: String(day) } }],
      { directory, now: new Date(`2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z`) },
    )
  const archives = readdirSync(directory)
  expect(archives).toHaveLength(HOSTED_ROW_RELEASE_ARCHIVE_KEEP)
  expect(archives[0]).toContain('2026-11-03')
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

test('hosted row release reports a presence failure and returns normally', async () => {
  const database = migratedTestDatabase()
  seedReleaseRows(database)
  const before = tableCounts(database)
  const output: string[] = []
  const dependencies = adapterDependencies(database, async () => {
    throw new Error('record unavailable')
  })
  await releaseHostedRowsAfterUpdate({ log: (line) => output.push(line) }, dependencies)
  expect(tableCounts(database)).toEqual(before)
  expect(output).toEqual([
    'kept all local workflow history: record presence read failed: record unavailable',
  ])
  database.close()
})
