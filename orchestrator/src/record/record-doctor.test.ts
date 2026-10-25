import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { ConfigClientError } from '../../../shared/config-client.ts'
import { HostedSecretError } from '../../../shared/hosted-secrets.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { applyMigrations } from '../database/migrations.ts'
import { seedWorkflows } from '../workflow/workflow-seeds.ts'
import {
  agentSecretChecks,
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

  test('agent credential rows reach the doctor report and fail it', () => {
    const checks = decideRecordDoctorChecks({
      ...healthyFacts,
      agentCredentialChecks: [
        { name: 'agent API key secret MISSING_KEY', status: 'fail', section: 'customer' },
      ],
    })

    expect(checks).toContainEqual({
      name: 'agent API key secret MISSING_KEY',
      status: 'fail',
      section: 'customer',
    })
    expect(recordDoctorExitCode(checks)).toBe(1)
  })

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
    expect(JSON.stringify(checks)).not.toContain('BOTTEGA_RECORD_URL')
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
        'record API: connection refused; check BOTTEGA_RECORD_API_URL and make the hosted record API reachable, then retry',
      section: 'customer',
    })
  })

  test('an unreachable API fails with its remedy', () => {
    const checks = decideRecordDoctorChecks({
      ...healthyFacts,
      apiReachable: false,
      apiFailure:
        'check BOTTEGA_RECORD_API_URL and make the hosted record API reachable, then retry',
      sessionAccepted: false,
      activeSpaceId: null,
      memberships: [],
    })
    expect(checks[1]).toEqual({
      name: 'hosted API reachable',
      status: 'fail',
      detail: 'check BOTTEGA_RECORD_API_URL and make the hosted record API reachable, then retry',
      section: 'customer',
    })
    expect(recordDoctorExitCode(checks)).toBe(1)
  })

  test('an unconfigured API directs the customer to record use', () => {
    const checks = decideRecordDoctorChecks({
      ...healthyFacts,
      apiConfigured: false,
      apiReachable: false,
      sessionAccepted: false,
      activeSpaceId: null,
      memberships: [],
    })
    expect(checks[0]).toEqual({
      name: 'hosted API address configured',
      status: 'fail',
      detail: `run \`${PLATFORM_SLUG} record use <address>\``,
      section: 'customer',
    })
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
    seedWorkflows(database)
    database
      .query(
        `INSERT INTO project (record_id,name,path,settings) VALUES
         ('01990000-0000-7000-8000-000000000101','default','/default','{}'),
         ('01990000-0000-7000-8000-000000000102','other','/other','{}'),
         ('01990000-0000-7000-8000-000000000103','unknown','/unknown','{}')`,
      )
      .run()
    const addRun = database.query(
      `INSERT INTO run
       (number,record_id,project_record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (?,?,?,'2026-09-25','codex','implement','sha',3,'ask','asking')`,
    )
    addRun.run(1, '01990000-0000-7000-8000-000000000001', '01990000-0000-7000-8000-000000000101')
    addRun.run(2, '01990000-0000-7000-8000-000000000002', '01990000-0000-7000-8000-000000000101')
    addRun.run(3, '01990000-0000-7000-8000-000000000003', '01990000-0000-7000-8000-000000000102')
    addRun.run(4, '01990000-0000-7000-8000-000000000004', '01990000-0000-7000-8000-000000000103')
    database
      .query(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES
         (1,'${newRecordId()}','01990000-0000-7000-8000-000000000001','2026-09-25','default'),
         (2,'${newRecordId()}','01990000-0000-7000-8000-000000000002','2026-09-25','unsynced'),
         (3,'${newRecordId()}','01990000-0000-7000-8000-000000000003','2026-09-25','other'),
         (4,'${newRecordId()}','01990000-0000-7000-8000-000000000004','2026-09-25','unknown')`,
      )
      .run()
    const cursorRecordId = newRecordId()
    database
      .query(
        `INSERT INTO workflow_cursor
         (record_id,number,project,project_record_id,workflow_slug,mode_slug,instance_id,session_id,workflow_version_record_id,catalogue_version_record_id,
          args,ordinal,step_slug,state,closed,total_steps,created_at,updated_at)
         VALUES (?,1,'default','01990000-0000-7000-8000-000000000101','test','default','','session',?,?,'{}',0,'step','awaiting-ruling','[]',1,
                 '2026-09-25','2026-09-25')`,
      )
      .run(cursorRecordId, workflowVersionRecordId(database), catalogueVersionRecordId(database))
    database
      .query(
        `INSERT INTO question (number,record_id,workflow_cursor_record_id,asked_at,question)
         VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}',?,'2026-09-25','workflow')`,
      )
      .run(cursorRecordId)
    database
      .query(
        `INSERT INTO outbox (record_id,kind,row_id,payload,created_at,synced_at) VALUES (?,'run','01990000-0000-7000-8000-000000000001','{}','2026-09-25','2026-09-25'),
                ('01990000-0000-7000-8000-000000000003','run','01990000-0000-7000-8000-000000000003','{}','2026-09-25','2026-09-25'),
                ('01990000-0000-7000-8000-000000000004','run','01990000-0000-7000-8000-000000000004','{}','2026-09-25','2026-09-25')`,
      )
      .run(newRecordId())

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
         (number,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,task_record_id)
         VALUES (1,'01990000-0000-7000-8000-000000000001','2026-09-25','codex','implement',
                 'sha',3,'ask','asking','fixture-task')`,
      )
      .run()
    database
      .query(
        `INSERT INTO question (number,record_id,run_record_id,asked_at,question) VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),'${newRecordId()}','01990000-0000-7000-8000-000000000001','2026-09-25','no project')`,
      )
      .run()
    database
      .query(
        `INSERT INTO outbox (record_id,kind,row_id,payload,created_at,synced_at) VALUES (?,'run','01990000-0000-7000-8000-000000000001','{}','2026-09-25','2026-09-25')`,
      )
      .run(newRecordId())

    expect(
      localQuestionCountForSpace(database, [], {
        id: 'space-id',
        slug: 'active-space',
      }),
    ).toBe(1)
    database.close()
  })
})

describe('record doctor agent secrets', () => {
  test('distinguishes a missing secret, a sealed-empty secret, and a set-but-empty secret', async () => {
    const missing = await agentSecretChecks(
      [{ enabled: true, apiKeySecret: 'MISSING_KEY' }],
      async () => ({ values: { MISSING_KEY: undefined }, sealedEmpty: [] }),
    )
    const sealedEmpty = await agentSecretChecks(
      [{ enabled: true, apiKeySecret: 'SEALED_EMPTY_KEY' }],
      async () => ({ values: { SEALED_EMPTY_KEY: undefined }, sealedEmpty: ['SEALED_EMPTY_KEY'] }),
    )
    const empty = await agentSecretChecks(
      [{ enabled: true, apiKeySecret: 'EMPTY_KEY' }],
      async () => ({ values: { EMPTY_KEY: '' }, sealedEmpty: [] }),
    )

    expect(missing[0]?.detail).toBe(
      `permanent: secret is not set\ncleared by: ${PLATFORM_SLUG} machine config secret set MISSING_KEY`,
    )
    expect(sealedEmpty[0]?.detail).toBe(
      `permanent: secret is sealed empty\ncleared by: ${PLATFORM_SLUG} machine config secret set SEALED_EMPTY_KEY`,
    )
    expect(empty[0]?.detail).toBe(
      `permanent: secret is set but empty\ncleared by: ${PLATFORM_SLUG} machine config secret set EMPTY_KEY`,
    )
  })

  test('checks each distinct enabled-agent secret once without reporting its value', async () => {
    const calls: string[][] = []
    const checks = await agentSecretChecks(
      [
        { enabled: true, apiKeySecret: 'SHARED_KEY' },
        { enabled: true, apiKeySecret: 'SHARED_KEY' },
        { enabled: false, apiKeySecret: 'DISABLED_KEY' },
      ],
      async (names) => {
        calls.push([...names])
        return { values: { SHARED_KEY: 'SECRET_VALUE_MARKER' }, sealedEmpty: [] }
      },
    )

    expect(calls).toEqual([['SHARED_KEY']])
    expect(checks).toEqual([
      {
        name: 'agent API key secret SHARED_KEY',
        status: 'pass',
        section: 'customer',
      },
    ])
    expect(JSON.stringify(checks)).not.toContain('SECRET_VALUE_MARKER')
    expect(JSON.stringify(checks)).not.toContain('DISABLED_KEY')
  })

  test('classifies a wrapped service failure with only safe cause facts', async () => {
    const sensitiveMarker = 'SECRET_RESPONSE_MARKER'
    const cause = new ConfigClientError('response', '/v1/config/secrets/SEALED_KEY', 503)
    cause.message = sensitiveMarker
    const checks = await agentSecretChecks(
      [{ enabled: true, apiKeySecret: 'SEALED_KEY' }],
      async () => {
        throw new HostedSecretError('SEALED_KEY', 'hosted-failure', cause)
      },
    )

    expect(checks[0]).toMatchObject({
      name: 'agent API key secret SEALED_KEY',
      status: 'fail',
      section: 'customer',
    })
    expect(checks[0]?.detail).toContain('transient')
    expect(checks[0]?.detail).toContain('cause: ConfigClientError')
    expect(checks[0]?.detail).toContain('status: 503')
    expect(checks[0]?.detail).toContain('reason: response')
    expect(checks[0]?.detail).not.toContain(sensitiveMarker)
  })

  test('an unreachable hosted record clears by waiting, not by running the doctor again as a fix', async () => {
    const checks = await agentSecretChecks(
      [{ enabled: true, apiKeySecret: 'SEALED_KEY' }],
      async () => {
        throw new ConfigClientError('unreachable', '/v1/config/secrets/SEALED_KEY')
      },
    )

    expect(checks[0]?.detail).toContain('transient')
    expect(checks[0]?.detail).toContain('cleared by: wait for the hosted record to recover')
    expect(checks[0]?.detail).not.toContain('checked by:')
  })

  test('a hosted failure without a service cause names a command, not a vague retry', async () => {
    const checks = await agentSecretChecks(
      [{ enabled: true, apiKeySecret: 'SEALED_KEY' }],
      async () => {
        throw new HostedSecretError('SEALED_KEY', 'hosted-failure', new Error('transport'))
      },
    )

    expect(checks[0]?.detail).toContain('cleared by: wait for the hosted record to recover')
  })
})
