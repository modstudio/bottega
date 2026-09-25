import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import {
  localQuestionCountForSpace,
  recordDoctorExitCode,
  redactRecordPasswords,
  unattributedShare,
} from './record-doctor.ts'

describe('record doctor decisions', () => {
  test('fails its exit code exactly when a named check fails', () => {
    expect(recordDoctorExitCode([{ name: 'ready', status: 'pass' }])).toBe(0)
    expect(
      recordDoctorExitCode([
        { name: 'optional', status: 'skipped', detail: 'not configured' },
        { name: 'owner', status: 'fail' },
      ]),
    ).toBe(1)
  })

  test('redacts URL passwords from diagnostics', () => {
    const url = 'postgres://record_actor:secret-value@record.example/db'
    expect(redactRecordPasswords(`could not connect to ${url}: secret-value`, [url])).toBe(
      'could not connect to postgres://record_actor:***@record.example/db: ***',
    )
  })

  test('reports unattributed rows rather than presenting a clean estate', () => {
    expect(unattributedShare(3, 4)).toBe('3/4 (75.0%) unattributed')
    expect(unattributedShare(0, 0)).toBe('0/0 (0.0%) unattributed')
  })

  test('counts only active-space questions whose parent run has synced', () => {
    const database = new Database(':memory:')
    applyMigrations(database)
    database
      .query(
        "INSERT INTO project (id,name,path,settings) VALUES (1,'active','/a','{}'),(2,'other','/b','{}')",
      )
      .run()
    const addRun = database.query(
      `INSERT INTO run
       (id,record_id,project_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (?,?,?,'2026-09-25','codex','implement','sha',3,'ask','asking')`,
    )
    addRun.run(1, '01990000-0000-7000-8000-000000000001', 1)
    addRun.run(2, '01990000-0000-7000-8000-000000000002', 1)
    addRun.run(3, '01990000-0000-7000-8000-000000000003', 2)
    database
      .query(
        "INSERT INTO question (run_id,asked_at,question) VALUES (1,'2026-09-25','one'),(2,'2026-09-25','two'),(3,'2026-09-25','three')",
      )
      .run()
    database
      .query(
        `INSERT INTO outbox (kind,record_id,payload,created_at,synced_at)
         VALUES ('run','01990000-0000-7000-8000-000000000001','{}','2026-09-25','2026-09-25'),
                ('run','01990000-0000-7000-8000-000000000003','{}','2026-09-25','2026-09-25')`,
      )
      .run()

    expect(
      localQuestionCountForSpace(
        database,
        [
          { name: 'active', space: 'active-space' },
          { name: 'other', space: 'other-space' },
        ],
        { id: 'space-id', slug: 'active-space' },
      ),
    ).toBe(1)
    database.close()
  })
})
