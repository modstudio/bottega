import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { providerCredentialTrustNotices } from './provider-credential-trust-notice.ts'

test('setup proposes the ordered provider credential trust notice from gathered facts', () => {
  const [notice] = providerCredentialTrustNotices([
    {
      status: 'checked',
      registered: false,
      revoked: false,
      trusted: false,
      ownedByAnotherUser: false,
      space: 'studio',
      keyId: 'key-id',
      publicKey: 'public-key',
    },
  ])
  expect(notice?.fix).toBe(
    `on this machine, run \`${PLATFORM_SLUG} machine config machine register --space studio\`; then from a machine already trusted in that space, run \`${PLATFORM_SLUG} machine config machine trust key-id public-key --space studio\``,
  )
})

test('setup reports when provider credential trust could not be checked', () => {
  expect(
    providerCredentialTrustNotices([
      { status: 'could-not-check', space: 'studio', reason: 'record timed out' },
    ]),
  ).toEqual([
    {
      message: `credential trust could not be checked in record space studio: record timed out; if this machine is not registered there, on this machine run \`${PLATFORM_SLUG} machine config machine register --space studio\`; then from a machine already trusted in that space, run \`${PLATFORM_SLUG} machine config machine trust <keyId> <publicKey> --space studio\``,
      fix: `${PLATFORM_SLUG} machine setup plan`,
      blocking: false,
    },
  ])
})
