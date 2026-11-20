import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  credentialMachineTrustFacts,
  credentialMachineTrustSteps,
} from '../../../shared/credential-machine-trust.ts'
import { anchoredTrustRefusal, machineTrustRefusal } from './machine-trust-refusal.ts'

const keyId = 'machine-key-id'

test('credential trust repair orders registration before trust and omits completed steps', () => {
  const facts = {
    status: 'checked' as const,
    space: 'named-space',
    keyId,
    publicKey: 'public-key',
    revoked: false,
    ownedByAnotherUser: false,
  }
  expect(credentialMachineTrustSteps({ ...facts, registered: false, trusted: false })).toEqual([
    `${PLATFORM_SLUG} machine config machine register --space named-space`,
    `${PLATFORM_SLUG} machine config machine trust ${keyId} public-key --space named-space`,
  ])
  expect(credentialMachineTrustSteps({ ...facts, registered: true, trusted: false })).toEqual([
    `${PLATFORM_SLUG} machine config machine trust ${keyId} public-key --space named-space`,
  ])
  expect(credentialMachineTrustSteps({ ...facts, registered: true, trusted: true })).toEqual([])
})

test('credential trust facts give a revoked machine key the init-new-key repair', () => {
  const facts = credentialMachineTrustFacts({
    space: 'named-space',
    signedInUserId: 'signed-in-user',
    machine: { keyId, publicKey: new Uint8Array([1, 2, 3]) },
    machineRows: [{ keyId, revokedAt: '2026-11-10T00:00:00.000Z', userId: 'signed-in-user' }],
    trust: { [keyId]: { public_key: 'public-key', label: 'fixture' } },
  })
  expect(facts).toEqual({
    status: 'checked',
    registered: false,
    revoked: true,
    trusted: true,
    ownedByAnotherUser: false,
    space: 'named-space',
    keyId,
    publicKey: 'AQID',
  })
  expect(credentialMachineTrustSteps(facts)).toEqual([
    `${PLATFORM_SLUG} machine config machine init --space named-space`,
    `${PLATFORM_SLUG} machine config machine register --space named-space`,
    `${PLATFORM_SLUG} machine config machine trust <keyId> <publicKey> --space named-space`,
  ])
})

test('revoked machine registration keeps every repair in the named space', () => {
  expect(machineTrustRefusal(keyId, { revokedAt: '2026-11-10T00:00:00.000Z' }, 'named-space')).toBe(
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

test('anchored trust checks the local key before the target key', () => {
  const local = 'local-key'
  const target = 'target-key'
  const key = { public_key: 'public-key', label: 'fixture' }

  expect(
    anchoredTrustRefusal({ anchored: false, keys: {} }, { local, target }, 'named-space'),
  ).toBeNull()
  expect(
    anchoredTrustRefusal(
      { anchored: true, keys: { [target]: key } },
      { local, target },
      'named-space',
    ),
  ).toBe(
    `this machine's key ${local} is not listed in the space's machine trust log\ncleared by: on this machine run \`${PLATFORM_SLUG} machine join --space named-space\`, then on a machine the trust log already trusts run \`${PLATFORM_SLUG} machine approve <code>\` with the code it prints`,
  )
  expect(
    anchoredTrustRefusal(
      { anchored: true, keys: { [local]: key } },
      { local, target },
      'named-space',
    ),
  ).toBe(
    `the space's machine trust log does not list ${target}\ncleared by: on that machine run \`${PLATFORM_SLUG} machine join --space named-space\`, then on a machine the trust log already trusts run \`${PLATFORM_SLUG} machine approve <code>\` with the code it prints`,
  )
  expect(
    anchoredTrustRefusal(
      { anchored: true, keys: { [local]: key, [target]: key } },
      { local, target },
      'named-space',
    ),
  ).toBeNull()
})
