import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { fixtureProjectRecordId, migratedTestDatabase } from '../database/test-database.fixture.ts'
import { writeTerminalRunResourceUsage } from './run-terminal.ts'

test('terminal persistence rounds resource measurements to whole units', () => {
  using database = migratedTestDatabase()
  fixtureProjectRecordId(database)
  const runId = newRecordId()
  database
    .query(
      `INSERT INTO run
       (number,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
       VALUES (1,?,'2026-10-24T00:00:00.000Z','codex','write','sha',4,'work','running',
               (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
    )
    .run(runId)

  writeTerminalRunResourceUsage(database, runId, {
    cpuMs: 99_279.999_999_999_99,
    peakRssBytes: 1_024.6,
    samples: 2,
    source: 'sampled',
  })

  expect(
    database
      .query('SELECT resource_cpu_ms,resource_peak_rss_bytes FROM run WHERE record_id=?')
      .get(runId),
  ).toEqual({ resource_cpu_ms: 99_280, resource_peak_rss_bytes: 1_025 })
})
