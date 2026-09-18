import { expect, test } from 'bun:test'
import { ConfigClientError, configClient } from './config-client.ts'

test('missing URL or session is a typed not-configured error', () => {
  expect(() => configClient({}, fetch, null)).toThrow(ConfigClientError)
  expect(() => configClient({ ORCH_RECORD_API_URL: 'https://record.test' }, fetch, null)).toThrow(
    'hosted config is not configured',
  )
})

test('config client names an unreachable route and response status without exposing bodies', async () => {
  const unreachable = configClient(
    { ORCH_RECORD_API_URL: 'https://record.test' },
    async () => {
      throw new Error('secret body')
    },
    'test',
  )
  await expect(unreachable.listSecrets()).rejects.toMatchObject({
    reason: 'unreachable',
    route: '/v1/config/secrets?environment=default',
  })
  const refused = configClient(
    { ORCH_RECORD_API_URL: 'https://record.test' },
    async () => new Response('secret body', { status: 403 }),
    'test',
  )
  let error: unknown
  try {
    await refused.listSecrets()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(ConfigClientError)
  expect(error).toMatchObject({ reason: 'response', status: 403 })
  expect((error as Error).message).not.toContain('secret body')
})
