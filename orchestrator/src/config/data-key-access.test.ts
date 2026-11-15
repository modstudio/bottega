import { expect, test } from 'bun:test'
import type { MachineKey } from '../../../shared/config-client.ts'
import type { TrustedKeys } from '../../../shared/trust-log-keys.ts'
import { wrapRecipientKeyIds } from './data-key-access.ts'

const machine = (keyId: string, userId: string | null, revokedAt: string | null): MachineKey => ({
  keyId,
  publicKey: `${keyId}-public`,
  signingPublicKey: null,
  label: keyId,
  createdAt: '2026-11-13T00:00:00.000Z',
  revokedAt,
  userId,
})

test('wrap recipients are claimed, unrevoked, and trusted record keys', () => {
  const trust: TrustedKeys = {
    included: { public_key: 'included-public', label: 'included' },
    unclaimed: { public_key: 'unclaimed-public', label: 'unclaimed' },
    revoked: { public_key: 'revoked-public', label: 'revoked' },
  }

  expect(
    wrapRecipientKeyIds(
      [
        machine('included', 'user-id', null),
        machine('unclaimed', null, null),
        machine('revoked', 'user-id', '2026-11-13T00:00:00.000Z'),
        machine('untrusted', 'user-id', null),
      ],
      trust,
    ),
  ).toEqual(['included'])
})
