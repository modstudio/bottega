import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
import type { ConfigClient } from '../../../shared/config-client.ts'
import { CONFIG_HOME_ENV } from '../../../shared/config-directory.ts'
import { writeMachineSigningKey } from '../../../shared/machine-signing-key.ts'
import {
  decodeTrustLogEntry,
  signTrustLogEntry,
  trustLogEntryHash,
  verifyTrustLog,
} from '../../../shared/trust-log.ts'
import {
  readRememberedTrustLogHead,
  writeRememberedTrustLogHead,
} from '../../../shared/trust-log-head.ts'
import { appendTrustLogRevoke } from './trust-log-revoke.ts'

const privateKey = (value: number) => new Uint8Array(32).fill(value)
const spaceId = '01990000-0000-7000-8000-000000000001'
const ownKeyId = 'own-key'
const targetKeyId = 'target-key'

function log() {
  const ownSigning = privateKey(1)
  const own = {
    keyId: ownKeyId,
    publicKey: new Uint8Array(32).fill(11),
    signingPublicKey: ed25519.getPublicKey(ownSigning),
    label: 'own',
  }
  const genesis = signTrustLogEntry(
    {
      prev: null,
      space: spaceId,
      body: {
        kind: 'genesis',
        first: own,
        recoveryPublicKey: ed25519.getPublicKey(privateKey(9)),
      },
      signer: own.signingPublicKey,
      at: 1,
    },
    ownSigning,
  )
  const target = {
    keyId: targetKeyId,
    publicKey: new Uint8Array(32).fill(12),
    signingPublicKey: ed25519.getPublicKey(privateKey(2)),
    label: 'target',
  }
  const add = signTrustLogEntry(
    {
      prev: trustLogEntryHash(genesis),
      space: spaceId,
      body: { kind: 'add', ...target },
      signer: own.signingPublicKey,
      at: 2,
    },
    ownSigning,
  )
  return { entries: [genesis, add], ownSigning }
}

function environment() {
  return {
    [CONFIG_HOME_ENV]: mkdtempSync(join(tmpdir(), 'trust-log-revoke-')),
    BOTTEGA_KEYSTORE: 'file',
  }
}

test('empty trust log preserves revoke without appending', async () => {
  let appended = false
  const client = {
    readTrustLog: async () => [],
    appendTrustLogEntry: async () => {
      appended = true
      return new Uint8Array(32)
    },
  } as unknown as ConfigClient
  await expect(
    appendTrustLogRevoke(client, ownKeyId, targetKeyId, spaceId, { env: environment(), at: 3 }),
  ).resolves.toBeNull()
  expect(appended).toBe(false)
})

test('trusted revoke appends a verified signed entry and remembers its head', async () => {
  const fixture = log()
  const env = environment()
  writeMachineSigningKey(
    { privateKey: fixture.ownSigning, publicKey: ed25519.getPublicKey(fixture.ownSigning) },
    env,
  )
  let appended: Uint8Array | null = null
  const client = {
    readTrustLog: async () => fixture.entries,
    appendTrustLogEntry: async (_head: Uint8Array, entry: Uint8Array) => {
      appended = entry
      return trustLogEntryHash(entry)
    },
  } as unknown as ConfigClient
  const head = await appendTrustLogRevoke(client, ownKeyId, targetKeyId, spaceId, {
    env,
    at: 3,
  })
  expect(head).toEqual(readRememberedTrustLogHead(spaceId, env))
  expect(decodeTrustLogEntry(appended!).body).toEqual({ kind: 'revoke', keyId: targetKeyId })
  expect(verifyTrustLog([...fixture.entries, appended!], { spaceId }).keys.has(targetKeyId)).toBe(
    false,
  )
})

test('fork refusal happens before append', async () => {
  const fixture = log()
  const env = environment()
  writeRememberedTrustLogHead(spaceId, new Uint8Array(32).fill(99), env)
  let appended = false
  const client = {
    readTrustLog: async () => fixture.entries,
    appendTrustLogEntry: async () => {
      appended = true
      return new Uint8Array(32)
    },
  } as unknown as ConfigClient
  await expect(
    appendTrustLogRevoke(client, ownKeyId, targetKeyId, spaceId, { env, at: 3 }),
  ).rejects.toThrow('stop, do not trust this record, and report it')
  expect(appended).toBe(false)
})
