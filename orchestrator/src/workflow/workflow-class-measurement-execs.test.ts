import { expect, test } from 'bun:test'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { classMeasurementExecCwd } from './workflow-class-measurement-execs.ts'

test('reads a numbered measurement exec cwd and returns undefined for an unknown number', () => {
  const database = migratedTestDatabase()
  try {
    const recordId = '01990000-0000-7000-8000-000000002646'
    database
      .query(
        `INSERT INTO probe(record_id,command,cwd,exit_code,output_tail,created_at,kind)
         VALUES (?, '[]', '/main/orchestrator', 0, '', 'at', 'exec')`,
      )
      .run(recordId)
    const number = database
      .query<{ number: number }, [string]>('SELECT number FROM probe WHERE record_id=?')
      .get(recordId)!.number

    expect(classMeasurementExecCwd(database, number)).toBe('/main/orchestrator')
    expect(classMeasurementExecCwd(database, number + 1_000)).toBeUndefined()
  } finally {
    database.close()
  }
})
