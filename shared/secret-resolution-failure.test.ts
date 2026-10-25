import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import { HostedSecretError } from './hosted-secrets.ts'
import { secretResolutionFailure } from './secret-resolution-failure.ts'

test('a hosted failure with no exhausted retry command falls back to naming the record doctor', () => {
  const detail = secretResolutionFailure(
    new HostedSecretError('SEALED_KEY', 'hosted-failure', new Error('transport')),
  )

  expect(detail).toContain(`cleared by: ${PLATFORM_SLUG} record doctor`)
})
