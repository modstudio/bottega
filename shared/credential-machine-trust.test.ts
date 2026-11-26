import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import {
  credentialMachineTrustCommands,
  credentialMachineTrustFacts,
  credentialMachineTrustSteps,
  machineAnchorCommand,
  machineApproveCommand,
  machineJoinCommand,
  machineRecoverCommand,
  missingDataKeyWrapRemedy,
  spaceHasNoDataKeyRemedy,
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

test('space-scoped machine command builders always name the space', () => {
  expect(machineApproveCommand(space)).toBe(
    `${PLATFORM_SLUG} machine approve <code> --space studio`,
  )
  expect(machineApproveCommand(space, '123-word-word')).toBe(
    `${PLATFORM_SLUG} machine approve 123-word-word --space studio`,
  )
  expect(machineJoinCommand(space)).toBe(`${PLATFORM_SLUG} machine join --space studio`)
  expect(machineAnchorCommand(space)).toBe(`${PLATFORM_SLUG} machine anchor --space studio`)
  expect(machineRecoverCommand(space)).toBe(`${PLATFORM_SLUG} machine recover --space studio`)
  expect(credentialMachineTrustCommands({ space }).init).toBe(
    `${PLATFORM_SLUG} machine config machine init --space studio`,
  )
  expect(credentialMachineTrustCommands({ space }).register).toBe(
    `${PLATFORM_SLUG} machine config machine register --space studio`,
  )
  expect(credentialMachineTrustCommands({ space }).trust).toBe(
    `${PLATFORM_SLUG} machine config machine trust <keyId> <publicKey> --space studio`,
  )
})

test('an unregistered credential machine is told to register and then trust this key', () => {
  expect(missingDataKeyWrapRemedy(facts([]))).toContain(
    `run \`${PLATFORM_SLUG} machine config machine register --space studio\`; then from a machine already trusted in that space, run \`${PLATFORM_SLUG} machine config machine trust machine-key AQID --space studio\``,
  )
})

test('a registered untrusted credential machine is told only to trust this key', () => {
  const remedy = missingDataKeyWrapRemedy(facts([row()]))
  expect(remedy).toContain(
    `${PLATFORM_SLUG} machine config machine trust machine-key AQID --space studio`,
  )
  expect(remedy).not.toContain('machine config machine register')
})

test('a registered and trusted unclaimed credential machine retains both facts', () => {
  expect(facts([row({ userId: null })], { [keyId]: {} })).toMatchObject({
    registered: true,
    trusted: true,
    ownedByAnotherUser: false,
  })
})

test('a credential machine key owned by another user offers only the supported account switch', () => {
  const observed = facts([row({ userId: 'other-user' })], { [keyId]: {} })
  const remedy = missingDataKeyWrapRemedy(observed)
  expect(observed).toMatchObject({
    registered: false,
    trusted: false,
    ownedByAnotherUser: true,
  })
  expect(remedy).toBe(
    "this machine's key in record space studio belongs to another account; sign back in as that account. Using this machine under a different account is not supported yet.",
  )
  expect(credentialMachineTrustSteps(observed)).toEqual([])
  expect(remedy).not.toContain('machine config machine init')
  expect(remedy).not.toContain('machine config machine register')
  expect(remedy).not.toContain('machine config machine trust')
})

test('a record space without a data key names registration and no trust command', () => {
  const remedy = spaceHasNoDataKeyRemedy(space)
  expect(remedy).toContain('record space studio has no data key yet')
  expect(remedy).toContain(`${PLATFORM_SLUG} machine config machine register --space studio`)
  expect(remedy).not.toContain('machine config machine trust')
})
