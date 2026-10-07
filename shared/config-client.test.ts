import { expect, test } from 'bun:test'
import { ConfigClientError, configClient } from './config-client.ts'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from './config-directory.ts'

test('missing URL or session is a typed not-configured error', () => {
  expect(() =>
    configClient(
      {
        [CONFIG_HOME_ENV]: '/definitely-missing-bottega-config',
        [HARNESS_ENV_FILE_ENV]: '',
      },
      fetch,
      null,
    ),
  ).toThrow(ConfigClientError)
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

test('config client refuses a non-JSON response with its source and response facts', async () => {
  const client = configClient(
    { ORCH_RECORD_API_URL: 'https://record.test' },
    async () =>
      new Response('<html>app</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    'test',
  )
  await expect(client.whoami()).rejects.toThrow(
    'hosted config refused the response from https://record.test/v1/whoami (status 200, content type text/html)',
  )
})

test('response diagnostics remove URL credentials, queries, and fragments', async () => {
  const errors: string[] = []
  for (const url of [
    'https://username:password@record.test',
    'https://record.test?token=query-secret#fragment-secret',
  ]) {
    const client = configClient(
      { ORCH_RECORD_API_URL: url },
      async () => new Response('html', { headers: { 'content-type': 'text/html' } }),
      'test',
    )
    try {
      await client.whoami()
    } catch (error) {
      errors.push((error as Error).message)
    }
  }
  expect(errors).toHaveLength(2)
  expect(errors.every((message) => message.includes('https://record.test/'))).toBe(true)
  for (const secret of ['username', 'password', 'query-secret', 'fragment-secret'])
    expect(errors.join('\n')).not.toContain(secret)
})
