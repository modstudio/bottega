import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { RECORD_PERSONAL_SPACE_REMEDY } from '../../../shared/record-remedies.ts'
import { questionWriteDestinations } from './record-question-destination.ts'

const PERSONAL_SPACE = '01990000-0000-7000-8000-000000002395'

test('question destination resolution forgets a rejected identity read and retries it', async () => {
  using database = new Database(':memory:')
  let reads = 0
  const destination = questionWriteDestinations({
    database,
    whoami: async () => {
      reads += 1
      if (reads === 1) throw new Error('identity unavailable')
      return {
        user: { id: '01990000-0000-7000-8000-000000002396' },
        activeSpaceId: PERSONAL_SPACE,
        personalSpaceId: PERSONAL_SPACE,
        memberships: [],
      }
    },
  })

  await expect(destination(null)).rejects.toThrow('identity unavailable')
  expect(await destination(null)).toEqual({ destinationSpaceId: PERSONAL_SPACE })
  expect(await destination(null)).toEqual({ destinationSpaceId: PERSONAL_SPACE })
  expect(reads).toBe(2)
})

test('personal question destination uses the shared missing-space remedy', async () => {
  using database = new Database(':memory:')
  const destination = questionWriteDestinations({
    database,
    whoami: async () => ({
      user: { id: '01990000-0000-7000-8000-000000002396' },
      activeSpaceId: null,
      personalSpaceId: null,
      memberships: [],
    }),
  })

  await expect(destination(null)).rejects.toThrow(RECORD_PERSONAL_SPACE_REMEDY)
})
