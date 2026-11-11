import { afterEach, expect, test } from 'bun:test'
import { personalRecordSpace } from './personal-record-space.ts'

const originalRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL

afterEach(() => {
  if (originalRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = originalRecordApiUrl
})

test('personal space is resolved through the record API whoami client', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const calls: string[] = []
  const space = await personalRecordSpace({
    token: 'session',
    fetch: async (input) => {
      calls.push(input)
      return Response.json({
        user: { id: 'user' },
        activeSpaceId: 'space-active',
        personalSpaceId: 'space-personal',
        memberships: [],
      })
    },
  })
  expect(space).toBe('space-personal')
  expect(calls).toEqual(['https://record.example.test/v1/whoami'])
})
