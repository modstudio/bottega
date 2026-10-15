import { expect, spyOn, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { RECORD_ACTOR_ROLE } from '../../../shared/record/schema.ts'
import { fakePostgres } from '../../test/fixtures/record-sync-postgres.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import { projectRecordId, syncHostedRecord } from './record-sync-service.ts'

const PROJECT_ID = '01990000-0000-7000-8000-000000000088'
const SPACE_ID = '01990000-0000-7000-8000-000000000001'
const OTHER_SPACE_ID = '01990000-0000-7000-8000-000000000777'
const MACHINE_ID = '01990000-0000-7000-8000-000000000099'
const PRINCIPAL = { userId: '01990000-0000-7000-8000-000000000002', spaceId: SPACE_ID }
const resolveProject = (
  remote: ReturnType<typeof fakePostgres>,
  payload: { projectId?: string; projectName: string },
) => remote.sql.begin((tx) => projectRecordId(tx, payload, PRINCIPAL))

test('project identity prefers id, logs one name mismatch, and falls back without id', async () => {
  const remote = fakePostgres(false, RECORD_ACTOR_ROLE, undefined, undefined, undefined, {
    id: PROJECT_ID,
    name: PLATFORM_SLUG,
    spaceId: SPACE_ID,
  })
  const warning = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(await resolveProject(remote, { projectId: PROJECT_ID, projectName: 'stale' })).toBe(
      PROJECT_ID,
    )
    expect(warning).toHaveBeenCalledTimes(1)
    expect(await resolveProject(remote, { projectName: PLATFORM_SLUG })).toBe(PROJECT_ID)
  } finally {
    warning.mockRestore()
  }
})

test('project identity refuses an id owned by another space', async () => {
  const remote = fakePostgres(false, RECORD_ACTOR_ROLE, undefined, undefined, undefined, {
    id: PROJECT_ID,
    name: PLATFORM_SLUG,
    spaceId: OTHER_SPACE_ID,
  })
  expect(
    resolveProject(remote, { projectId: PROJECT_ID, projectName: PLATFORM_SLUG }),
  ).rejects.toThrow('absent from request space')
})

test('a run payload with projectId syncs for a retired project', async () => {
  const payload = Object.fromEntries(
    OUTBOX_PAYLOAD_CONTRACTS.run.columns.map((column) => [column, null]),
  )
  Object.assign(payload, {
    id: '01990000-0000-7000-8000-000000000042',
    spaceId: SPACE_ID,
    projectId: PROJECT_ID,
    projectName: PLATFORM_SLUG,
    machineId: MACHINE_ID,
    localId: 42,
    startedAt: '2026-10-14T00:00:00.000Z',
    agent: 'codex',
    job: 'proof',
    promptSha: 'prompt',
    promptBytes: 6,
    promptHead: 'prompt',
    probe: false,
    status: 'ok',
    turn: 1,
    noFailover: false,
    automaticFailover: false,
    workPreserved: false,
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z',
  })
  const remote = fakePostgres(false, RECORD_ACTOR_ROLE, undefined, undefined, undefined, {
    id: PROJECT_ID,
    name: PLATFORM_SLUG,
    spaceId: SPACE_ID,
    retiredAt: '2026-10-14T00:00:00.000Z',
  })

  await expect(
    syncHostedRecord({
      url: 'postgres://record.test/database',
      identity: {
        user: { id: PRINCIPAL.userId },
        activeSpaceId: SPACE_ID,
        personalSpaceId: SPACE_ID,
        memberships: [{ space_id: SPACE_ID, slug: 'platform', permission: 'write' }],
      },
      request: {
        machine: { id: MACHINE_ID, name: 'proof-machine', seenAt: '2026-10-14T00:00:00.000Z' },
        rows: [{ id: 1, kind: 'run', payload: JSON.stringify(payload), spaceHint: SPACE_ID }],
      },
      postgres: remote.sql,
    }),
  ).resolves.toEqual({ results: [{ id: 1, status: 'synced' }] })
})
