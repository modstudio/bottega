import { expect, test } from 'bun:test'
import { noteDestinationOptions } from './note-project-space.ts'

test('a note without a project targets the personal space', async () => {
  const options = await noteDestinationOptions(null, {
    baseUrl: 'https://hub.example.test',
    token: 'session',
    fetch: async (input) => {
      expect(new URL(input).pathname).toBe('/v1/whoami')
      return Response.json({ personalSpaceId: 'space-personal' })
    },
  })
  expect(options.recordSpace).toBe('space-personal')
})
