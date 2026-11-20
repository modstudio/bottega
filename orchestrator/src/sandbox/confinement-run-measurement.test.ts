import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  fixtureProjectRecordId,
  migratedTestDatabase,
} from '../database/test-database.fixture.ts'
import {
  CONFINEMENT_RUN_WINDOW_MS,
  confinementRunWindow,
  formatConfinementRunMeasurement,
  measureConfinementRuns,
} from './confinement-run-measurement.ts'

const NOW = Date.parse('2026-11-20T12:00:00.000Z')

test('the default confinement window is the named seven-day interval', () => {
  expect(confinementRunWindow(undefined, NOW)).toEqual({
    since: new Date(NOW - CONFINEMENT_RUN_WINDOW_MS).toISOString(),
    defaultWindow: true,
  })
  expect(confinementRunWindow('2026-11-19T01:02:03-05:00', NOW)).toEqual({
    since: '2026-11-19T01:02:03-05:00',
    defaultWindow: false,
  })
})

test('read-only runs are counted by sandbox and reason while old null reasons are named', () => {
  const database = migratedTestDatabase()
  const projectId = fixtureProjectRecordId(database)
  const insert = database.query(
    `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,
        project_record_id,sandbox,sandbox_reason)
     VALUES (?,?,?,'grok',?,'sha',1,'head','ok',?,?,?)`,
  )
  insert.run(
    newRecordId(),
    1,
    '2026-11-19T00:00:00.000Z',
    'understand',
    projectId,
    'host',
    null,
  )
  insert.run(
    newRecordId(),
    2,
    '2026-11-19T01:00:00.000Z',
    'review-lens',
    projectId,
    'srt',
    'eligible read-only repository run',
  )
  insert.run(
    newRecordId(),
    3,
    '2026-11-19T02:00:00.000Z',
    'implement',
    projectId,
    'srt',
    'writer',
  )
  insert.run(
    newRecordId(),
    4,
    '2026-11-10T00:00:00.000Z',
    'understand',
    projectId,
    'host',
    'old',
  )

  const measurement = measureConfinementRuns(database, undefined, NOW)
  expect(measurement.rows).toEqual([
    { sandbox: 'host', reason: 'unrecorded', count: 1 },
    { sandbox: 'srt', reason: 'eligible read-only repository run', count: 1 },
  ])
  expect(formatConfinementRunMeasurement(measurement)[0]).toBe(
    'read-only-run-window  since=2026-11-13T12:00:00.000Z (default seven days)',
  )
  database.close()
})
