import { expect, test } from 'bun:test'
import { credentialIdentityKey } from './credential.ts'

test('credential storage identity is injective across name and provider boundaries', () => {
  const first = {
    provider: 'aws',
    name: 'backup',
    type: 'access-key',
    mode: 'default' as const,
    environment: 'local' as const,
  }
  const second = {
    provider: 'aws-backup',
    name: null,
    type: 'access-key',
    mode: 'default' as const,
    environment: 'local' as const,
  }
  expect(credentialIdentityKey(first)).not.toBe(credentialIdentityKey(second))
})
