import { afterEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { addDoctrineRule } from './porting.ts'

const space = '01990000-0000-7000-8000-000000000333'
const at = '2026-10-18T12:00:00.000Z'
const whoami = async () => ({
  user: { id: newRecordId() },
  activeSpaceId: space,
  personalSpaceId: space,
  memberships: [],
})

afterEach(() => {
  delete process.env.ORCH_RECORD_API_URL
  installRecordApiClient(createMemoryRecordApiClient())
})

test('hosted port failure is inert and success adopts the hosted identity', async () => {
  process.env.ORCH_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami,
    async writePort() {
      throw new Error('hosted doctrine failed')
    },
  })
  await expect(addDoctrineRule(991, 'Hosted', 'Hosted body.', at)).rejects.toThrow(
    'hosted doctrine failed',
  )
  expect(db().query('SELECT 1 FROM port_doctrine WHERE number=991').get()).toBeNull()

  const id = newRecordId()
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami,
    async writePort() {
      return {
        doctrine: {
          id,
          spaceId: space,
          number: 991,
          title: 'Hosted',
          body: 'Hosted body.',
          createdAt: at,
          retiredAt: null,
          version: 1,
          updatedAt: at,
        },
      }
    },
  })
  await addDoctrineRule(991, 'Hosted', 'Hosted body.', at)
  expect(
    db().query('SELECT record_id FROM port_doctrine WHERE space_id=? AND number=991').get(space),
  ).toEqual({ record_id: id })
})
