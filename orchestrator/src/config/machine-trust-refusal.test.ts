import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { machineTrustRefusal } from './machine-trust-refusal.ts'

const keyId = 'machine-key-id'

test('revoked machine registration keeps every repair in the named space', () => {
  expect(
    machineTrustRefusal(keyId, { revokedAt: '2026-11-10T00:00:00.000Z' }, 'named-space'),
  ).toBe(
    `machine key ${keyId} was revoked in this space and cannot be trusted again\ncleared by: on that machine run \`${PLATFORM_SLUG} machine config machine init --space named-space\` to make a new key, then \`${PLATFORM_SLUG} machine config machine register --space named-space\`, and trust the new key with \`${PLATFORM_SLUG} machine config machine trust <keyId> <publicKey> --space named-space\``,
  )
})

test('named-space repair keeps registration and trust in that space', () => {
  expect(machineTrustRefusal(keyId, undefined, 'named-space')).toBe(
    `machine key ${keyId} is not registered in this space\ncleared by: on that machine run \`${PLATFORM_SLUG} machine config machine register --space named-space\`, then trust it again with \`${PLATFORM_SLUG} machine config machine trust <keyId> <publicKey> --space named-space\``,
  )
})

test('active machine registration proceeds', () => {
  expect(machineTrustRefusal(keyId, { revokedAt: null }, 'named-space')).toBeNull()
})
