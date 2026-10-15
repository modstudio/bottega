import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from '../database/migrations.ts'
import {
  decideRecordDoctorChecks,
  localQuestionCountForSpace,
  recordDoctorExitCode,
  redactRecordPasswords,
  unattributedShare,
} from './record-doctor.ts'

describe('record doctor decisions', () => {
  const healthyFacts = {
    apiConfigured: true,
    apiReachable: true,
    sessionAccepted: true,
    attributionFailure: null,
    activeSpaceId: 'space-1',
    memberships: [
      { spaceId: 'space-1', slug: 'workshop', permission: 'write' },
      { spaceId: 'space-2', slug: 'library', permission: 'read' },
    ],
    projects: [
      { name: PLATFORM_NAME, space: 'workshop' },
      { name: 'local-only', space: null },
    ],
    pendingOutboxRows: 2,
    quarantinedOutboxRows: [],
    operatorConnectionPresent: false,
  } as const

  test('a healthy customer machine needs no operator connection or secret', () => {
    const checks = decideRecordDoctorChecks(healthyFacts)
    expect(recordDoctorExitCode(checks)).toBe(0)
    expect(checks.map((check) => check.name)).toEqual([
      'hosted API address configured',
      'hosted API reachable',
      'stored session accepted',
      'last run attribution resolution',
      'session active space',
      'membership workshop',
      'membership library',
      `project ${PLATFORM_NAME} declared space`,
      'local outbox pending rows',
      'local outbox quarantined rows',
    ])
    expect(JSON.stringify(checks)).not.toContain('ORCH_RECORD_URL')
    expect(JSON.stringify(checks)).not.toContain('BETTER_AUTH_SECRET')
  })

  test('a stored-session attribution failure directs the customer to sign in', () => {
    const checks = decideRecordDoctorChecks({
      ...healthyFacts,
      attributionFailure: 'stored record session: keychain unavailable',
    })
    expect(checks).toContainEqual({
      name: 'last run attribution resolution',
      status: 'fail',
      detail: `stored record session: keychain unavailable; record session is missing or expired; run \`${PLATFORM_SLUG} record sign-in --email <email>\``,
      section: 'customer',
    })
  })

  test('a hosted-call attribution failure directs the customer to API reachability', () => {
    const checks = decideRecordDoctorChecks({
      ...healthyFacts,
      attributionFailure: 'record API: connection refused',
    })
    expect(checks).toContainEqual({
      name: 'last run attribution resolution',
      status: 'fail',
      detail:
        'record API: connection refused; check ORCH_RECORD_API_URL and make the hosted record API reachable, then retry',
      section: 'customer',
    })
  })

  test('an unreachable API fails with its remedy', () => {
    const checks = decideRecordDoctorChecks({
      ...healthyFacts,
      apiReachable: false,
      apiFailure: 'check ORCH_RECORD_API_URL and make the hosted record API reachable, then retry',
      sessionAccepted: false,
      activeSpaceId: null,
      memberships: [],
    })
    expect(checks[1]).toEqual({
      name: 'hosted API reachable',
      status: 'fail',
      detail: 'check ORCH_RECORD_API_URL and make the hosted record API reachable, then retry',
      section: 'customer',
    })
    expect(recordDoctorExitCode(checks)).toBe(1)
  })

  test('a project declaring an unavailable space fails and names it', () => {
    const checks = decideRecordDoctorChecks({
      ...healthyFacts,
      projects: [{ name: 'foreign', space: 'outside' }],
    })
    expect(checks).toContainEqual({
      name: 'project foreign declared space',
      status: 'fail',
      detail: "outside is not one of the signed-in user's memberships; join it with an invitation",
      section: 'customer',
    })
    expect(recordDoctorExitCode(checks)).toBe(1)
  })

  test('does not diagnose project memberships when the session was not accepted', () => {
    const checks = decideRecordDoctorChecks({
      ...healthyFacts,
      sessionAccepted: false,
      activeSpaceId: null,
      memberships: [],
      projects: [{ name: 'unseen', space: 'outside' }],
    })
    expect(checks).not.toContainEqual(
      expect.objectContaining({ name: 'project unseen declared space' }),
    )
    expect(checks).toContainEqual({
      name: 'user memberships',
      status: 'fail',
      detail: `record session is missing or expired; run \`${PLATFORM_SLUG} record sign-in --email <email>\``,
      section: 'customer',
    })
  })

  test('operator checks appear only when the actor connection is present', () => {
    const operatorCheck = {
      name: 'record connection works',
      status: 'pass' as const,
    }
    expect(
      decideRecordDoctorChecks({
        ...healthyFacts,
        operatorChecks: [operatorCheck],
      }),
    ).not.toContainEqual(expect.objectContaining({ section: 'operator' }))
    expect(
      decideRecordDoctorChecks({
        ...healthyFacts,
        operatorConnectionPresent: true,
        operatorChecks: [operatorCheck],
      }),
    ).toContainEqual({ ...operatorCheck, section: 'operator' })
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
        `INSERT INTO question (record_id,run_id,asked_at,question) VALUES
         ('${newRecordId()}',1,'2026-09-25','default'),
         ('${newRecordId()}',2,'2026-09-25','unsynced'),
         ('${newRecordId()}',3,'2026-09-25','other'),
         ('${newRecordId()}',4,'2026-09-25','unknown')`,
      )
      .run()
    database
      .query(
        `INSERT INTO workflow_cursor
         (record_id,project,workflow_slug,mode_slug,instance_id,session_id,workflow_version,catalogue_version,
          args,ordinal,step_slug,state,closed,total_steps,created_at,updated_at)
         VALUES ('${newRecordId()}','default','test','default','','session',1,1,'{}',0,'step','awaiting-ruling','[]',1,
                 '2026-09-25','2026-09-25')`,
      )
      .run()
    database
      .query(
        `INSERT INTO question (record_id,workflow_cursor_id,asked_at,question)
         VALUES ('${newRecordId()}',last_insert_rowid(),'2026-09-25','workflow')`,
      )
      .run()
    database
      .query(
        `INSERT INTO outbox (record_id,kind,row_id,payload,created_at,synced_at) VALUES (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-7' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),'run','01990000-0000-7000-8000-000000000001','{}','2026-09-25','2026-09-25'),
                ('01990000-0000-7000-8000-000000000003','run','01990000-0000-7000-8000-000000000003','{}','2026-09-25','2026-09-25'),
                ('01990000-0000-7000-8000-000000000004','run','01990000-0000-7000-8000-000000000004','{}','2026-09-25','2026-09-25')`,
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
      .query(
        `INSERT INTO question (record_id,run_id,asked_at,question) VALUES ('${newRecordId()}',1,'2026-09-25','no project')`,
      )
      .run()
    database
      .query(
        `INSERT INTO outbox (record_id,kind,row_id,payload,created_at,synced_at) VALUES (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-7' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),'run','01990000-0000-7000-8000-000000000001','{}','2026-09-25','2026-09-25')`,
      )
      .run()

    expect(
      localQuestionCountForSpace(database, [], {
        id: 'space-id',
        slug: 'active-space',
      }),
    ).toBe(1)
    database.close()
  })
})
