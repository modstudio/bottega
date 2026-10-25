import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import type { RunResourceUsage } from '../process-resource-sampler.ts'
import { writeTerminalRunResourceUsage } from '../run/run-terminal.ts'
import { fixtureProjectRecordId, migratedTestDatabase } from './test-database.fixture.ts'

test('every terminal run resource source is accepted by the migrated run table', () => {
  const database = migratedTestDatabase()
  fixtureProjectRecordId(database)
  try {
    const runId = newRecordId()
    database
      .query(
        `INSERT INTO run
          (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
         VALUES (?,1,'2026-10-21','codex','implement','sha',1,'prompt','running',
                 (SELECT record_id FROM project ORDER BY name LIMIT 1))`,
      )
      .run(runId)

    const usages: RunResourceUsage[] = [
      { cpuMs: 1, peakRssBytes: 2, samples: 1, source: 'sampled' },
      { cpuMs: null, peakRssBytes: null, samples: 0, source: 'none' },
      { cpuMs: null, peakRssBytes: null, samples: 0, source: 'unavailable' },
    ]
    for (const usage of usages) {
      expect(() => writeTerminalRunResourceUsage(database, runId, usage)).not.toThrow()
      expect(
        database.query('SELECT resource_source FROM run WHERE record_id=?').get(runId),
      ).toEqual({ resource_source: usage.source })
    }
  } finally {
    database.close()
  }
})
