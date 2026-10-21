import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { fakePostgres } from '../../test/fixtures/record-sync-postgres.ts'
import { OUTBOX_HELD_FOR_UPGRADE_MARKER } from './outbox-held-contract.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import { syncHostedRecord } from './record-sync-service.ts'

const MACHINE_ID = '01990000-0000-7000-8000-000000000099'
const SPACE_ID = '01990000-0000-7000-8000-000000000001'
const USER_ID = '01990000-0000-7000-8000-000000000002'

async function triageSnapshotResult(mutate: (payload: Record<string, unknown>) => void) {
  const payload = Object.fromEntries(
    OUTBOX_PAYLOAD_CONTRACTS.landing_triage_snapshot.columns.map((column) => [column, null]),
  )
  mutate(payload)
  return (
    await syncHostedRecord({
      url: 'postgres://record.test/database',
      postgres: fakePostgres().sql,
      identity: {
        user: { id: USER_ID },
        activeSpaceId: SPACE_ID,
        personalSpaceId: SPACE_ID,
        memberships: [{ space_id: SPACE_ID, slug: 'active', permission: 'write' }],
      },
      request: {
        machine: { id: MACHINE_ID, name: 'test-machine', seenAt: '2026-10-21T00:00:00.000Z' },
        rows: [
          {
            id: 1,
            kind: 'landing_triage_snapshot',
            payload: JSON.stringify(payload),
            spaceHint: null,
          },
        ],
      },
    })
  ).results[0]!
}

test('an extra-only payload is held for a hosted API upgrade', async () => {
  const result = await triageSnapshotResult((payload) => {
    Object.assign(payload, { zebraColumn: null, alphaColumn: null })
  })
  expect(result).toEqual({
    id: 1,
    status: 'held',
    reason: `${OUTBOX_HELD_FOR_UPGRADE_MARKER} landing_triage_snapshot outbox payload has unknown columns: alphaColumn, zebraColumn; the hosted record API predates this client; run \`${PLATFORM_SLUG} release run ${PLATFORM_SLUG} --rung hosted-api\` to clear it`,
  })
})

test.each([
  {
    name: 'missing-only',
    mutate: (payload: Record<string, unknown>) => delete payload.branch,
  },
  {
    name: 'extra-and-missing',
    mutate: (payload: Record<string, unknown>) => {
      delete payload.branch
      Object.assign(payload, { futureColumn: null })
    },
  },
])('$name payload mismatches remain quarantined', async ({ mutate }) => {
  expect(await triageSnapshotResult(mutate)).toEqual({
    id: 1,
    status: 'quarantined',
    reason: 'landing_triage_snapshot outbox payload has an unexpected column set',
  })
})
