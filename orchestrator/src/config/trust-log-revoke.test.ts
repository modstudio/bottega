import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
import type { ConfigClient } from '../../../shared/config-client.ts'
import { CONFIG_HOME_ENV } from '../../../shared/config-directory.ts'
import { writeMachineSigningKey } from '../../../shared/machine-signing-key.ts'
import { decodeTrustLogEntry, verifyTrustLog } from '../../../shared/trust-log.ts'
import {
  readRememberedTrustLogHead,
  writeRememberedTrustLogHead,
} from '../../../shared/trust-log-head.ts'
import {
  machineRevokeTrustLogFixture,
  trackedTrustLogClient,
} from './config-service-trust-log.fixture.ts'
import { appendTrustLogRevoke } from './trust-log-revoke.ts'

const privateKey = (value: number) => new Uint8Array(32).fill(value)
const spaceId = '01990000-0000-7000-8000-000000000001'
const ownKeyId = 'own-key'
const targetKeyId = 'target-key'
const ownSigning = privateKey(1)
const entries = machineRevokeTrustLogFixture(
  true,
  spaceId,
  [ownKeyId, new Uint8Array(32).fill(11), ed25519.getPublicKey(ownSigning), 'own'],
  [targetKeyId, new Uint8Array(32).fill(12), ed25519.getPublicKey(privateKey(2)), 'target'],
  ownSigning,
)

function environment() {
  return {
    [CONFIG_HOME_ENV]: mkdtempSync(join(tmpdir(), 'trust-log-revoke-')),
    BOTTEGA_KEYSTORE: 'file',
  }
}

test('empty trust log preserves revoke without appending', async () => {
  const client = trackedTrustLogClient([])
  await expect(
    appendTrustLogRevoke(
      client.methods as unknown as ConfigClient,
      ownKeyId,
      targetKeyId,
      spaceId,
      {
        env: environment(),
        at: 3,
      },
    ),
  ).resolves.toBeNull()
  expect(client.appendedTrustLogEntry()).toBeNull()
})

test('trusted revoke appends a verified signed entry and remembers its head', async () => {
  const env = environment()
  writeMachineSigningKey(
    { privateKey: ownSigning, publicKey: ed25519.getPublicKey(ownSigning) },
    env,
  )
  const client = trackedTrustLogClient(entries)
  const head = await appendTrustLogRevoke(
    client.methods as unknown as ConfigClient,
    ownKeyId,
    targetKeyId,
    spaceId,
    { env, at: 3 },
  )
  const appended = client.appendedTrustLogEntry()
  expect(head).toEqual(readRememberedTrustLogHead(spaceId, env))
  expect(decodeTrustLogEntry(appended!).body).toEqual({ kind: 'revoke', keyId: targetKeyId })
  expect(verifyTrustLog([...entries, appended!], { spaceId }).keys.has(targetKeyId)).toBe(false)
})

test('fork refusal happens before append', async () => {
  const env = environment()
  writeRememberedTrustLogHead(spaceId, new Uint8Array(32).fill(99), env)
  const client = trackedTrustLogClient(entries)
  await expect(
    appendTrustLogRevoke(
      client.methods as unknown as ConfigClient,
      ownKeyId,
      targetKeyId,
      spaceId,
      {
        env,
        at: 3,
      },
    ),
  ).rejects.toThrow('stop, do not trust this record, and report it')
  expect(client.appendedTrustLogEntry()).toBeNull()
})

test('local signing key must match the key trusted for this machine before append', async () => {
  const env = environment()
  const otherSigning = privateKey(8)
  writeMachineSigningKey(
    { privateKey: otherSigning, publicKey: ed25519.getPublicKey(otherSigning) },
    env,
  )
  const client = trackedTrustLogClient(entries)
  await expect(
    appendTrustLogRevoke(
      client.methods as unknown as ConfigClient,
      ownKeyId,
      targetKeyId,
      spaceId,
      {
        env,
        at: 3,
      },
    ),
  ).rejects.toThrow(
    "this machine's signing key is not the key the space machine trust log trusts for its key id; have an owner re-approve this machine from an approved machine before retrying the revoke",
  )
  expect(client.appendedTrustLogEntry()).toBeNull()
})
