import { expect, test } from 'bun:test'
import { ConfigClientError } from '../../../shared/config-client.ts'
import { resolveOperatorCredential } from './operator-credential.ts'

const identity = { provider: 'fly', name: 'metrics', type: 'token' } as const

test('a non-empty override wins without resolving the typed credential', async () => {
  let called = false
  const value = await resolveOperatorCredential(identity, 'TOKEN_OVERRIDE', undefined, {
    env: { TOKEN_OVERRIDE: 'override-value' },
    resolve: async () => {
      called = true
      return 'stored-value'
    },
  })

  expect(value).toBe('override-value')
  expect(called).toBeFalse()
})

test('a missing typed credential returns undefined', async () => {
  expect(
    await resolveOperatorCredential(identity, 'TOKEN_OVERRIDE', undefined, {
      env: {},
      resolve: async () => undefined,
    }),
  ).toBeUndefined()
})

test('an unconfigured record session returns undefined', async () => {
  expect(
    await resolveOperatorCredential(identity, 'TOKEN_OVERRIDE', undefined, {
      env: {},
      resolve: async () => {
        throw new ConfigClientError('not-configured', '/v1/config')
      },
    }),
  ).toBeUndefined()
})

test('any other resolution failure is thrown', async () => {
  const failure = new Error('credential service unavailable')
  await expect(
    resolveOperatorCredential(identity, 'TOKEN_OVERRIDE', undefined, {
      env: {},
      resolve: async () => {
        throw failure
      },
    }),
  ).rejects.toBe(failure)
})
