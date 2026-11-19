import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { RECORD_SIGN_IN_REMEDY } from '../../../shared/record-remedies.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { applyMigrations } from '../database/migrations.ts'
import type { RecordApiClient } from './record-api-client.ts'
import { RecordApiRequestError } from './record-api-client-response.ts'
import { identity } from './record-api-identity.fixture.ts'
import {
  decideRecordCacheParity,
  type RecordCacheParityInput,
  recordCacheParityChecks,
} from './record-cache-parity.ts'
import {
  decideRecordDoctorChecks,
  type RecordDoctorCheck,
  recordDoctorExitCode,
} from './record-doctor.ts'

const base = {
  space: 'space-a',
  activeSpace: 'space-a',
  projectSpaces: new Map([
    ['alpha', 'space-a'],
    ['outside', 'space-b'],
  ]),
  local: { byScope: [{ scope: 'canon', docs: 2 }], subjects: 3 },
  hosted: {
    byScope: [{ scope: 'canon', project: 'alpha', docs: 2 }],
    subjectsByProject: [{ project: 'alpha', subjects: 3 }],
  },
} satisfies RecordCacheParityInput

describe('record cache parity decision', () => {
  test('an exact cache passes', () => {
    expect(decideRecordCacheParity(base)).toEqual({
      name: 'record cache parity: space-a',
      status: 'pass',
      detail: 'canon: 2 local; 2 hosted — ok\nsubjects: 3 local; 3 hosted — ok',
      section: 'customer',
    })
  })

  test('a missing local group fails doctor with the pull remedy', () => {
    const decision = decideRecordCacheParity({
      ...base,
      local: { byScope: [{ scope: 'canon', docs: 1 }], subjects: 2 },
    })
    expect(decision).toMatchObject({ status: 'fail' })
    expect(decision.detail).toContain('canon: 1 local; 2 hosted — missing locally')
    expect(decision.detail).toContain('subjects: 2 local; 3 hosted — missing locally')
    expect(decision.detail).toContain(`run \`${PLATFORM_SLUG} record pull\``)
    expect(recordDoctorExitCode([decision])).toBe(1)
  })

  test('local extras are shown and pass', () => {
    const decision = decideRecordCacheParity({
      ...base,
      local: { byScope: [{ scope: 'canon', docs: 4 }], subjects: 5 },
    })
    expect(decision.status).toBe('pass')
    expect(decision.detail).toContain('canon: 4 local; 2 hosted — extra locally')
    expect(decision.detail).toContain('subjects: 5 local; 3 hosted — extra locally')
  })

  test('unowned groups are excluded and every owned scope is compared', () => {
    const decision = decideRecordCacheParity({
      ...base,
      hosted: {
        ...base.hosted,
        byScope: [
          ...base.hosted.byScope,
          { scope: 'canon', project: 'outside', docs: 9 },
          { scope: 'future', project: null, docs: 4 },
        ],
      },
    })
    expect(decision.status).toBe('fail')
    expect(decision.detail).not.toContain('9')
    expect(decision.detail).toContain('future: 0 local; 4 hosted — missing locally')
  })

  test('a missing breakdown or unreachable host fails without presenting zero', () => {
    const missing = decideRecordCacheParity({ ...base, hosted: undefined })
    expect(missing).toMatchObject({ status: 'fail' })
    expect(missing.detail).toContain('could not establish')
    expect(missing.detail).not.toContain('0 hosted')

    const unreachable = decideRecordCacheParity({
      ...base,
      hosted: undefined,
      failure: 'connection refused',
    })
    expect(unreachable).toMatchObject({ status: 'fail' })
    expect(unreachable.detail).toContain('connection refused')
    expect(unreachable.detail).toContain('make the hosted record API reachable')
    expect(unreachable.detail).not.toContain('0 hosted')
  })
})

afterEach(() => installRecordApiClient(null))

function localCache(): Database {
  const local = new Database(':memory:')
  applyMigrations(local)
  const projectId = newRecordId()
  local
    .query(
      `INSERT INTO project (record_id,name,path,settings)
       VALUES (?,'alpha','/alpha','{"space":"space-a"}')`,
    )
    .run(projectId)
  local
    .query(
      `INSERT INTO doc
       (record_id,scope,subject,slug,title,body,delivery,created_at,updated_at,audiences,space_id)
       VALUES (?,'project','alpha','parity-doc','Parity doc','Body','demand','a','a','["technical"]','space-a')`,
    )
    .run(newRecordId())
  local
    .query(
      `INSERT INTO subject
       (id,project_record_id,name,definition,position,created_at,updated_at,space_id)
       VALUES (?,?,'Parity subject','Parity definition.',0,'a','a','space-a')`,
    )
    .run(newRecordId(), projectId)
  return local
}

const healthyDoctorFacts = {
  apiConfigured: true,
  apiReachable: true,
  sessionAccepted: true,
  attributionFailure: null,
  activeSpaceId: 'space-a',
  memberships: [{ spaceId: 'space-a', slug: 'space-a', permission: 'write' as const }],
  projects: [{ name: 'alpha', space: 'space-a' }],
  pendingOutboxRows: 0,
  runRecordBackfill: {
    enqueue: 0,
    'refresh-number': 0,
    'refresh-links': 0,
    'refresh-root': 0,
    none: 0,
    released: 0,
    live: 0,
  },
  quarantinedOutboxRows: [],
  noDestinationWrites: { windowStart: '2026-11-19T00:00:00.000Z', unrecorded: 0, counts: [] },
  hubNoDestinationWrites: {
    windowStart: '2026-11-19T00:00:00.000Z',
    unrecorded: 0,
    counts: [],
  },
  operatorConnectionPresent: false,
} as const

async function doctorChecks(
  local: Database,
  cacheCounts: RecordApiClient['cacheCounts'],
): Promise<RecordDoctorCheck[]> {
  installRecordApiClient({ ...createMemoryRecordApiClient(), cacheCounts })
  const recordCacheChecks = await recordCacheParityChecks(local, identity)
  return decideRecordDoctorChecks({ ...healthyDoctorFacts, recordCacheChecks })
}

describe('record cache parity doctor checks', () => {
  test('a matching local cache reaches the doctor as a pass', async () => {
    using local = localCache()
    const checks = await doctorChecks(local, async () => ({
      docs: 1,
      revisions: 0,
      scores: 0,
      voids: 0,
      byScope: [{ scope: 'project', project: 'alpha', docs: 1 }],
      subjectsByProject: [{ project: 'alpha', subjects: 1 }],
    }))

    expect(checks).toContainEqual({
      name: 'record cache parity: space-a',
      status: 'pass',
      detail: 'project: 1 local; 1 hosted — ok\nsubjects: 1 local; 1 hosted — ok',
      section: 'customer',
    })
    expect(recordDoctorExitCode(checks)).toBe(0)
  })

  test('a scope and project cache mismatch reaches the doctor as a failure', async () => {
    using local = localCache()
    const checks = await doctorChecks(local, async () => ({
      docs: 4,
      revisions: 0,
      scores: 0,
      voids: 0,
      byScope: [{ scope: 'project', project: 'alpha', docs: 2 }],
      subjectsByProject: [{ project: 'alpha', subjects: 2 }],
    }))
    const parity = checks.find((check) => check.name === 'record cache parity: space-a')

    expect(parity).toMatchObject({ status: 'fail', section: 'customer' })
    expect(parity?.detail).toContain('project: 1 local; 2 hosted — missing locally')
    expect(parity?.detail).toContain('subjects: 1 local; 2 hosted — missing locally')
    expect(parity?.detail).toContain(`run \`${PLATFORM_SLUG} record pull\``)
    expect(recordDoctorExitCode(checks)).toBe(1)
  })

  test('a non-conforming hosted breakdown fails instead of counting it as zero', async () => {
    using local = localCache()
    const checks = await doctorChecks(local, async () => ({
      docs: 1,
      revisions: 0,
      scores: 0,
      voids: 0,
      byScope: [{ scope: 'project', project: 'alpha', docs: Number.NaN }],
      subjectsByProject: [{ project: 'alpha', subjects: 1 }],
    }))
    const parity = checks.find((check) => check.name === 'record cache parity: space-a')

    expect(parity).toMatchObject({ status: 'fail' })
    expect(parity?.detail).toContain('could not establish')
    expect(parity?.detail).not.toContain('0 hosted')
    expect(recordDoctorExitCode(checks)).toBe(1)
  })

  test('a refused counts request reaches the doctor with the sign-in remedy', async () => {
    using local = localCache()
    const checks = await doctorChecks(local, async () => {
      throw new RecordApiRequestError('session refused', 'refused', 401)
    })
    const parity = checks.find((check) => check.name === 'record cache parity: space-a')

    expect(parity).toMatchObject({ status: 'fail' })
    expect(parity?.detail).toContain('could not establish: session refused')
    expect(parity?.detail).toContain(RECORD_SIGN_IN_REMEDY)
    expect(recordDoctorExitCode(checks)).toBe(1)
  })
})
