import { afterEach, expect, test } from 'bun:test'
import { noteDestinationOptions } from './note-project-space.ts'

const originalRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL

afterEach(() => {
  if (originalRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = originalRecordApiUrl
})

test('a note without a project targets the personal space', async () => {
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  const options = await noteDestinationOptions(null, {
    baseUrl: 'https://hub.example.test',
    token: 'session',
    fetch: async (_input) => {
      return Response.json({
        user: { id: 'user' },
        activeSpaceId: null,
        personalSpaceId: 'space-personal',
        memberships: [],
      })
    },
  })
  expect(options.recordSpace).toBe('space-personal')
})
