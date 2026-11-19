import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { fixtureProjectRecordId, migrationBoundaryTestDatabase } from './test-database.fixture.ts'

test('own failure kind backfill includes continued roots', () => {
  const database = migrationBoundaryTestDatabase('0236_run_own_failure_kind')
  try {
    const continuedRoot = newRecordId()
    const terminalRoot = newRecordId()
    const turn = newRecordId()
    const project = fixtureProjectRecordId(database)
    const insert = database.query(
      `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,
          failure_kind,parent_run_record_id,turn,project_record_id)
       VALUES (?,?,'2026-11-19','codex','file-question','sha',1,'head','failed',?,?,?,?)`,
    )
    insert.run(continuedRoot, 1, 'contract', null, 1, project)
    insert.run(terminalRoot, 2, 'other', null, 1, project)
    insert.run(turn, 3, 'quota', continuedRoot, 2, project)

    expect(applyMigrations(database)).toEqual(['0236_run_own_failure_kind'])
    expect(
      database.query('SELECT record_id,own_failure_kind FROM run ORDER BY number').all(),
    ).toEqual([
      { record_id: continuedRoot, own_failure_kind: 'contract' },
      { record_id: terminalRoot, own_failure_kind: 'other' },
      { record_id: turn, own_failure_kind: 'quota' },
    ])

    database.query("UPDATE run SET failure_kind='quota' WHERE record_id=?").run(continuedRoot)
    expect(applyMigrations(database)).toEqual([])
    expect(
      database
        .query('SELECT failure_kind,own_failure_kind FROM run WHERE record_id=?')
        .get(continuedRoot),
    ).toEqual({ failure_kind: 'quota', own_failure_kind: 'contract' })
  } finally {
    database.close()
  }
})
