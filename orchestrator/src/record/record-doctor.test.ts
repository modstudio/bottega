import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import {
  localQuestionCountForSpace,
  outboxQuarantineCheck,
  outboxRetiredParentCheck,
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

  test('fails while an outbox row is quarantined', () => {
    const database = new Database(':memory:')
    applyMigrations(database)
    database
      .query(
        `INSERT INTO outbox
         (id,kind,record_id,payload,created_at,quarantined_at,quarantine_reason)
         VALUES (12,'score','record-12','{}','2026-09-28','2026-09-28','verdict refused')`,
      )
      .run()
    const check = outboxQuarantineCheck(database)
    expect(check).toMatchObject({ name: 'outbox quarantine is empty', status: 'fail' })
    expect(check.detail).toContain('12 score')
    expect(recordDoctorExitCode([check])).toBe(1)
    database.close()
  })

  test('fails while an active outbox row is blocked by a retired parent', () => {
    const database = new Database(':memory:')
    applyMigrations(database)
    database
      .query(
        `INSERT INTO outbox
         (id,kind,record_id,payload,created_at,retired_at,retirement_reason)
         VALUES (11,'run','parent','{}','2026-09-28','2026-09-28','not deliverable'),
                (12,'run','child','{"parentRunId":"parent"}','2026-09-28',NULL,NULL)`,
      )
      .run()
    const check = outboxRetiredParentCheck(database)
    expect(check).toMatchObject({
      name: 'outbox has no rows blocked by a retired parent',
      status: 'fail',
    })
    expect(check.detail).toContain('12 run (parent parent)')
    expect(recordDoctorExitCode([check])).toBe(1)
    database.close()
  })

  test('counts synced questions for projects whose effective space is active', () => {
    const database = new Database(':memory:')
    applyMigrations(database)
    database
      .query(
        `INSERT INTO project (id,name,path,settings) VALUES
         (1,'default','/default','{}'),
         (2,'other','/other','{}'),
         (3,'unknown','/unknown','{}')`,
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
    addRun.run(4, '01990000-0000-7000-8000-000000000004', 3)
    database
      .query(
        `INSERT INTO question (run_id,asked_at,question) VALUES
         (1,'2026-09-25','default'),
         (2,'2026-09-25','unsynced'),
         (3,'2026-09-25','other'),
         (4,'2026-09-25','unknown')`,
      )
      .run()
    database
      .query(
        `INSERT INTO workflow_cursor
         (project,workflow_slug,mode_slug,instance_id,session_id,workflow_version,catalogue_version,
          args,ordinal,step_slug,state,closed,total_steps,created_at,updated_at)
         VALUES ('default','test','default','','session',1,1,'{}',0,'step','awaiting-ruling','[]',1,
                 '2026-09-25','2026-09-25')`,
      )
      .run()
    database
      .query(
        `INSERT INTO question (workflow_cursor_id,asked_at,question)
         VALUES (last_insert_rowid(),'2026-09-25','workflow')`,
      )
      .run()
    database
      .query(
        `INSERT INTO outbox (kind,record_id,payload,created_at,synced_at)
         VALUES ('run','01990000-0000-7000-8000-000000000001','{}','2026-09-25','2026-09-25'),
                ('run','01990000-0000-7000-8000-000000000003','{}','2026-09-25','2026-09-25'),
                ('run','01990000-0000-7000-8000-000000000004','{}','2026-09-25','2026-09-25')`,
      )
      .run()

    expect(
      localQuestionCountForSpace(
        database,
        [
          { name: 'default', space: null },
          { name: 'other', space: 'other-space' },
        ],
        { id: 'space-id', slug: 'active-space' },
      ),
    ).toBe(3)
    database.close()
  })

  test('counts a synced question whose run has no project in the active space', () => {
    const database = new Database(':memory:')
    applyMigrations(database)
    database
      .query(
        `INSERT INTO run
         (id,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
         VALUES (1,'01990000-0000-7000-8000-000000000001','2026-09-25','codex','implement',
                 'sha',3,'ask','asking')`,
      )
      .run()
    database
      .query("INSERT INTO question (run_id,asked_at,question) VALUES (1,'2026-09-25','no project')")
      .run()
    database
      .query(
        `INSERT INTO outbox (kind,record_id,payload,created_at,synced_at)
         VALUES ('run','01990000-0000-7000-8000-000000000001','{}','2026-09-25','2026-09-25')`,
      )
      .run()

    expect(localQuestionCountForSpace(database, [], { id: 'space-id', slug: 'active-space' })).toBe(
      1,
    )
    database.close()
  })
})
