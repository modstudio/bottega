import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import {
  credentialMachineTrustFacts,
  missingDataKeyWrapRemedy,
  noDataKeyRemedy,
} from './credential-machine-trust.ts'

const space = 'studio'
const keyId = 'machine-key'
const signedInUserId = 'signed-in-user'
const machine = { keyId, publicKey: new Uint8Array([1, 2, 3]) }
const row = (overrides: { userId?: string | null; revokedAt?: string | null } = {}) => ({
  keyId,
  userId: overrides.userId === undefined ? signedInUserId : overrides.userId,
  revokedAt: overrides.revokedAt ?? null,
})
const facts = (
  machineRows: ReturnType<typeof row>[],
  trust: Readonly<Record<string, unknown>> = {},
) => credentialMachineTrustFacts({ space, signedInUserId, machine, machineRows, trust })

test('an unregistered credential machine is told to register and then trust this key', () => {
  expect(missingDataKeyWrapRemedy(facts([]))).toContain(
    `run \`${PLATFORM_SLUG} machine config machine register --space studio\`; then from a machine already trusted in that space, run \`${PLATFORM_SLUG} machine config machine trust machine-key AQID --space studio\``,
  )
})

test('a revoked credential machine is told to initialize, register, and trust a new key', () => {
  const remedy = missingDataKeyWrapRemedy(facts([row({ revokedAt: '2026-11-10T00:00:00.000Z' })]))
  expect(remedy).toContain(`${PLATFORM_SLUG} machine config machine init --space studio`)
  expect(remedy).toContain(`${PLATFORM_SLUG} machine config machine trust <keyId> <publicKey>`)
})

test('a registered untrusted credential machine is told only to trust this key', () => {
  const remedy = missingDataKeyWrapRemedy(facts([row()]))
  expect(remedy).toContain(
    `${PLATFORM_SLUG} machine config machine trust machine-key AQID --space studio`,
  )
  expect(remedy).not.toContain('machine config machine register')
})

test('a trusted credential machine is told that its data-key wrap is missing', () => {
  expect(missingDataKeyWrapRemedy(facts([row()], { [keyId]: {} }))).toBe(
    `this machine has no data-key wrap in record space studio; from a machine that already opens that space, run \`${PLATFORM_SLUG} machine config machine trust machine-key AQID --space studio\``,
  )
})

test('a registered and trusted unclaimed credential machine retains both facts', () => {
  expect(facts([row({ userId: null })], { [keyId]: {} })).toMatchObject({
    registered: true,
    trusted: true,
    ownedByAnotherUser: false,
  })
})

test('a credential machine key owned by another user offers both account-switch intents', () => {
  const observed = facts([row({ userId: 'other-user' })], { [keyId]: {} })
  const remedy = missingDataKeyWrapRemedy(observed)
  expect(observed).toMatchObject({
    registered: false,
    trusted: false,
    ownedByAnotherUser: true,
  })
  expect(remedy).toContain("sign back in as the account that owns this machine's key")
  expect(remedy).toContain(`${PLATFORM_SLUG} machine config machine init --space studio`)
  expect(remedy).toContain(`${PLATFORM_SLUG} machine config machine register --space studio`)
  expect(remedy).toContain(
    `${PLATFORM_SLUG} machine config machine trust <keyId> <publicKey> --space studio`,
  )
  expect(remedy).not.toContain('machine config machine trust machine-key')
})

test('a record space without a data key names registration and no trust command', () => {
  const remedy = noDataKeyRemedy(space)
  expect(remedy).toContain('record space studio has no data key yet')
  expect(remedy).toContain(`${PLATFORM_SLUG} machine config machine register --space studio`)
  expect(remedy).not.toContain('machine config machine trust')
})
