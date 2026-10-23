import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { ConfigClientError } from '../../../shared/config-client.ts'
import { HostedSecretError } from '../../../shared/hosted-secrets.ts'
import {
  decideEndpointApiKey,
  decideEndpointApiKeyRetry,
  ENDPOINT_API_KEY_RESOLUTION_MAX_ATTEMPTS,
  resolveEndpointApiKeyEnv,
} from './endpoint-api-key.ts'

test('an endpoint without a secret reference keeps local authentication', () => {
  expect(decideEndpointApiKey({ baseUrl: 'http://127.0.0.1:8000/v1' }, undefined)).toEqual({
    ok: true,
    env: { OPENAI_API_KEY: 'local' },
  })
  expect(decideEndpointApiKey({}, undefined)).toEqual({ ok: true, env: {} })
})

test('a resolved named key becomes the endpoint key without exposing its name as an env key', () => {
  expect(
    decideEndpointApiKey(
      { baseUrl: 'https://example.test/v1', apiKeySecret: 'ENDPOINT_KEY' },
      'sealed-value',
    ),
  ).toEqual({ ok: true, env: { OPENAI_API_KEY: 'sealed-value' } })
})

test('an unresolved named key refuses with the setting command', async () => {
  await expect(
    resolveEndpointApiKeyEnv(
      { baseUrl: 'https://example.test/v1', apiKeySecret: 'MISSING_KEY' },
      async () => ({ MISSING_KEY: undefined }),
    ),
  ).rejects.toThrow(
    `agent endpoint API key MISSING_KEY could not be resolved\ncleared by: ${PLATFORM_SLUG} machine config secret set MISSING_KEY`,
  )
})

test('a sealed-store failure is not reported as an unset secret', async () => {
  await expect(
    resolveEndpointApiKeyEnv(
      { baseUrl: 'https://example.test/v1', apiKeySecret: 'SEALED_KEY' },
      async () => {
        throw new HostedSecretError('SEALED_KEY', 'machine-key-missing')
      },
    ),
  ).rejects.toThrow(
    `agent endpoint API key SEALED_KEY could not be resolved: hosted secret SEALED_KEY could not be opened: machine-key-missing\ncleared by: ${PLATFORM_SLUG} machine config machine init`,
  )
})

test('endpoint key retry policy retries only transient failures within the attempt bound', () => {
  expect(decideEndpointApiKeyRetry({ kind: 'hosted-failure' }, 1)).toEqual({
    retry: true,
    delayMs: 250,
  })
  expect(decideEndpointApiKeyRetry({ kind: 'config-client', reason: 'unreachable' }, 2)).toEqual({
    retry: true,
    delayMs: 500,
  })
  expect(
    decideEndpointApiKeyRetry({ kind: 'config-client', reason: 'response', status: 429 }, 1),
  ).toEqual({ retry: true, delayMs: 250 })
  expect(
    decideEndpointApiKeyRetry({ kind: 'config-client', reason: 'response', status: 503 }, 1),
  ).toEqual({ retry: true, delayMs: 250 })
  expect(
    decideEndpointApiKeyRetry({ kind: 'config-client', reason: 'response', status: 403 }, 1),
  ).toEqual({ retry: false, retriesExhausted: false })
  expect(
    decideEndpointApiKeyRetry({ kind: 'hosted-failure' }, ENDPOINT_API_KEY_RESOLUTION_MAX_ATTEMPTS),
  ).toEqual({ retry: false, retriesExhausted: true })
})

test('endpoint key resolution succeeds after one transient failure without a real wait', async () => {
  let attempts = 0
  const delays: number[] = []
  const env = await resolveEndpointApiKeyEnv(
    { baseUrl: 'https://example.test/v1', apiKeySecret: 'SEALED_KEY' },
    async () => {
      attempts += 1
      if (attempts === 1)
        throw new HostedSecretError('SEALED_KEY', 'hosted-failure', new Error('temporary'))
      return { SEALED_KEY: 'sealed-value' }
    },
    async (delayMs) => {
      delays.push(delayMs)
    },
  )

  expect(env).toEqual({ OPENAI_API_KEY: 'sealed-value' })
  expect(attempts).toBe(2)
  expect(delays).toEqual([250])
})

test('an exhausted transient refusal safely names its cause and retry remedy', async () => {
  const sensitiveMarker = 'SECRET_REQUEST_MARKER'
  const cause = new ConfigClientError('response', '/v1/config/secrets', 503)
  cause.message = sensitiveMarker
  const error = new HostedSecretError('SEALED_KEY', 'hosted-failure', cause)

  let refusal = ''
  try {
    await resolveEndpointApiKeyEnv(
      { baseUrl: 'https://example.test/v1', apiKeySecret: 'SEALED_KEY' },
      async () => {
        throw error
      },
      async () => {},
    )
  } catch (caught) {
    refusal = String((caught as Error).message)
  }

  expect(refusal).toContain('cause: ConfigClientError')
  expect(refusal).toContain('status: 503')
  expect(refusal).toContain('reason: response')
  expect(refusal).toContain(`cleared by: ${PLATFORM_SLUG} run retry <run>`)
  expect(refusal).not.toContain(sensitiveMarker)
})
