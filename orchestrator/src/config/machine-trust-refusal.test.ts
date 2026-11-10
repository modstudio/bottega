import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { machineTrustRefusal } from './machine-trust-refusal.ts'

const keyId = 'machine-key-id'

test('missing machine registration names registration as the repair', () => {
  expect(machineTrustRefusal(keyId, undefined)).toBe(
    `machine key ${keyId} is not registered in this space\ncleared by: on that machine run \`${PLATFORM_SLUG} machine config machine register\`, then trust it again`,
  )
})

test('revoked machine registration requires a new key', () => {
  expect(machineTrustRefusal(keyId, { revokedAt: '2026-11-10T00:00:00.000Z' })).toBe(
    `machine key ${keyId} was revoked in this space and cannot be trusted again\ncleared by: on that machine run \`${PLATFORM_SLUG} machine config machine init\` to make a new key, then \`${PLATFORM_SLUG} machine config machine register\`, and trust the new key`,
  )
})

test('named-space repair keeps registration and trust in that space', () => {
  expect(machineTrustRefusal(keyId, undefined, 'named-space')).toBe(
    `machine key ${keyId} is not registered in this space\ncleared by: on that machine run \`${PLATFORM_SLUG} machine config machine register --space named-space\`, then trust it again with \`${PLATFORM_SLUG} machine config machine trust <keyId> <publicKey> --space named-space\``,
  )
})

test('active machine registration proceeds', () => {
  expect(machineTrustRefusal(keyId, { revokedAt: null })).toBeNull()
})
