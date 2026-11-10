import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import { ConfigClientError } from './config-client.ts'
import { HostedSecretError } from './hosted-secrets.ts'
import { secretResolutionFailure } from './secret-resolution-failure.ts'

const route = '/v1/config/secrets/SEALED_KEY'
const refusal = {
  error: "this machine's key is revoked in the space",
  remedy: 'initialize and register a new machine key',
}

test('a hosted config refusal renders the record condition and remedy', () => {
  const detail = secretResolutionFailure(
    new HostedSecretError(
      'SEALED_KEY',
      'hosted-failure',
      new ConfigClientError('response', route, 422, refusal),
    ),
  )

  expect(detail).toBe(
    `hosted secret SEALED_KEY could not be opened: ${refusal.error}\ncleared by: ${refusal.remedy}`,
  )
})

test('a bare config refusal renders the record condition and remedy', () => {
  const detail = secretResolutionFailure(new ConfigClientError('response', route, 422, refusal))

  expect(detail).toBe(`${refusal.error}\ncleared by: ${refusal.remedy}`)
})

test('a config refusal without display fields keeps the generic remedy', () => {
  const detail = secretResolutionFailure(new ConfigClientError('response', route, 422))

  expect(detail).toBe(
    'hosted secret service refused the request\ncleared by: restore hosted secret access, then retry',
  )
})

test('an arbitrary cause message is never rendered', () => {
  const marker = 'PRIVATE_EXCEPTION_MARKER'
  const detail = secretResolutionFailure(
    new HostedSecretError('SEALED_KEY', 'hosted-failure', new Error(marker)),
  )

  expect(detail).not.toContain(marker)
})

test('a hosted failure with no exhausted retry command falls back to naming the record doctor', () => {
  const detail = secretResolutionFailure(
    new HostedSecretError('SEALED_KEY', 'hosted-failure', new Error('transport')),
  )

  expect(detail).toContain(`cleared by: ${PLATFORM_SLUG} record doctor`)
})
