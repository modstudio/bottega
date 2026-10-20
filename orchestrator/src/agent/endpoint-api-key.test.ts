import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { HostedSecretError } from '../../../shared/hosted-secrets.ts'
import { decideEndpointApiKey, resolveEndpointApiKeyEnv } from './endpoint-api-key.ts'

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
