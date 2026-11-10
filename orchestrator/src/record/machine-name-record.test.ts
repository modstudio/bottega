import { expect, test } from 'bun:test'
import { fakePostgres } from '../../test/fixtures/record-sync-postgres.ts'
import { upsertHostedMachine } from './machine-name-record.ts'

const USER_ID = '01990000-0000-7000-8000-000000000001'
const MACHINE_ID = '01990000-0000-7000-8000-000000000002'
const PERSONAL_SPACE_ID = '01990000-0000-7000-8000-000000000003'
const SPACE_A = '01990000-0000-7000-8000-000000000004'
const SPACE_B = '01990000-0000-7000-8000-000000000005'

test('machine names are claimed once in every distinct sync destination space', async () => {
  const remote = fakePostgres()

  await upsertHostedMachine(
    remote.sql,
    '2026-11-10T12:00:00.000Z',
    { id: MACHINE_ID, shortName: 'fixture', displayName: 'Fixture' },
    { userId: USER_ID, spaceId: PERSONAL_SPACE_ID },
    [SPACE_A, SPACE_B, SPACE_A],
  )

  expect(remote.transactionSpaceIds).toEqual([PERSONAL_SPACE_ID, SPACE_A, SPACE_B])
})

test('an empty sync destination set updates the user-owned machine without making a claim', async () => {
  const remote = fakePostgres()

  await upsertHostedMachine(
    remote.sql,
    '2026-11-10T12:00:00.000Z',
    { id: MACHINE_ID, shortName: 'fixture', displayName: 'Fixture' },
    { userId: USER_ID, spaceId: PERSONAL_SPACE_ID },
    [],
  )

  expect(remote.transactionSpaceIds).toEqual([PERSONAL_SPACE_ID])
  expect(remote.statements.filter((statement) => statement.includes('machine_name_claim'))).toEqual([])
})
