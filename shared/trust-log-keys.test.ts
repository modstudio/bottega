import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
import type { ConfigClient } from './config-client.ts'
import { machineKeyId } from './machine-key-id.ts'
import { generateMachineKeyPair } from './secret-envelope.ts'
import { pinTrustedMachine } from './trust-list.ts'
import { signTrustLogEntry, type TrustLogKey, trustLogEntryHash } from './trust-log.ts'
import { readRememberedTrustLogHead, writeRememberedTrustLogHead } from './trust-log-head.ts'
import { trustedKeysForSpace } from './trust-log-keys.ts'

const roots: string[] = []
const spaceId = '01990000-0000-7000-8000-000000000001'

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function environment() {
  const root = mkdtempSync(join(tmpdir(), 'trust-log-keys-'))
  roots.push(root)
  return { BOTTEGA_CONFIG_HOME: root, BOTTEGA_KEYSTORE: 'file' }
}

const clientWith = (entries: Uint8Array[]) =>
  ({ readTrustLog: async () => entries }) as Pick<ConfigClient, 'readTrustLog'>

async function logKey(
  label: string,
  value: number,
): Promise<{ key: TrustLogKey; signing: Uint8Array }> {
  const pair = await generateMachineKeyPair()
  const signing = new Uint8Array(32).fill(value)
  return {
    key: {
      keyId: await machineKeyId(pair.publicKey),
      publicKey: pair.publicKey,
      signingPublicKey: ed25519.getPublicKey(signing),
      label,
    },
    signing,
  }
}

function genesis(first: TrustLogKey, signing: Uint8Array) {
  return signTrustLogEntry(
    {
      prev: null,
      space: spaceId,
      body: {
        kind: 'genesis',
        first,
        recoveryPublicKey: ed25519.getPublicKey(new Uint8Array(32).fill(99)),
      },
      signer: first.signingPublicKey,
      at: 1,
    },
    signing,
  )
}

test('an empty log without a remembered head returns only the pin-file key fields', async () => {
  const env = environment()
  const pair = await generateMachineKeyPair()
  const keyId = await machineKeyId(pair.publicKey)
  await pinTrustedMachine(keyId, pair.publicKey, 'pinned', env)

  await expect(trustedKeysForSpace(clientWith([]), spaceId, env)).resolves.toEqual({
    [keyId]: { public_key: Buffer.from(pair.publicKey).toString('base64url'), label: 'pinned' },
  })
})

test('an empty log with a remembered head refuses the record', async () => {
  const env = environment()
  writeRememberedTrustLogHead(spaceId, new Uint8Array(32).fill(7), env)

  await expect(trustedKeysForSpace(clientWith([]), spaceId, env)).rejects.toThrow(
    'is empty although this machine has seen a head; do not trust this record, and report it',
  )
})

test('a present log replaces pinned keys and advances the remembered head', async () => {
  const env = environment()
  const pinned = await generateMachineKeyPair()
  const pinnedId = await machineKeyId(pinned.publicKey)
  await pinTrustedMachine(pinnedId, pinned.publicKey, 'pinned-only', env)
  const logged = await logKey('logged', 1)
  const entry = genesis(logged.key, logged.signing)

  const trusted = await trustedKeysForSpace(clientWith([entry]), spaceId, env)

  expect(trusted[pinnedId]).toBeUndefined()
  expect(trusted[logged.key.keyId]).toEqual({
    public_key: Buffer.from(logged.key.publicKey).toString('base64url'),
    label: 'logged',
  })
  expect(readRememberedTrustLogHead(spaceId, env)).toEqual(trustLogEntryHash(entry))
})

test('a log that omits the remembered head refuses rollback', async () => {
  const env = environment()
  const accepted = await logKey('accepted', 2)
  const acceptedEntry = genesis(accepted.key, accepted.signing)
  await trustedKeysForSpace(clientWith([acceptedEntry]), spaceId, env)
  const replacement = await logKey('replacement', 3)

  await expect(
    trustedKeysForSpace(clientWith([genesis(replacement.key, replacement.signing)]), spaceId, env),
  ).rejects.toThrow('trust log fork or rollback')
})
