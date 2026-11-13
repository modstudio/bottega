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
  machineRevokeTrustLogFixture,
  trackedTrustLogClient,
} from './config-service-trust-log.fixture.ts'
import { appendSignedTrustLogEntry } from './trust-log-append.ts'

test('shared signed append verifies and appends an add entry', async () => {
  const spaceId = '01990000-0000-7000-8000-000000000001'
  const signingPrivateKey = new Uint8Array(32).fill(1)
  const signingPublicKey = ed25519.getPublicKey(signingPrivateKey)
  const entries = machineRevokeTrustLogFixture(
    true,
    spaceId,
    ['own-key', new Uint8Array(32).fill(11), signingPublicKey, 'own'],
    ['target-key', new Uint8Array(32).fill(12), ed25519.getPublicKey(new Uint8Array(32).fill(2)), 'target'],
    signingPrivateKey,
  )
  const env = {
    [CONFIG_HOME_ENV]: mkdtempSync(join(tmpdir(), 'trust-log-append-')),
    BOTTEGA_KEYSTORE: 'file',
  }
  writeMachineSigningKey({ privateKey: signingPrivateKey, publicKey: signingPublicKey }, env)
  const tracked = trackedTrustLogClient(entries)
  await appendSignedTrustLogEntry(
    tracked.methods as unknown as ConfigClient,
    'own-key',
    spaceId,
    {
      kind: 'add',
      keyId: 'joining-key',
      publicKey: new Uint8Array(32).fill(21),
      signingPublicKey: ed25519.getPublicKey(new Uint8Array(32).fill(22)),
      label: 'joining',
    },
    'machine approve',
    { at: 3, env },
  )
  const appended = tracked.appendedTrustLogEntry()!
  expect(decodeTrustLogEntry(appended).body).toMatchObject({ kind: 'add', keyId: 'joining-key' })
  expect(verifyTrustLog([...entries, appended], { spaceId }).keys.has('joining-key')).toBeTrue()
})
