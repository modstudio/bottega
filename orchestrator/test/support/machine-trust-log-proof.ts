import { expect } from 'bun:test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { signTrustLogEntry, trustLogEntryHash } from '../../../shared/trust-log.ts'
import type { ConfigTenant } from '../../src/record/record-config.ts'
import {
  appendMachineTrustLogEntry,
  readMachineTrustLog,
} from '../../src/record/record-machine-trust-log.ts'
import { succeeds } from '../fixtures/postgres-rls.ts'

export async function proveMachineTrustLog(
  tenant: ConfigTenant,
  spaceA: string,
  spaceB: string,
): Promise<void> {
  const privateKey = new Uint8Array(32).fill(7)
  const signingPublicKey = ed25519.getPublicKey(privateKey)
  const genesis = signTrustLogEntry(
    {
      prev: null,
      space: spaceA,
      body: {
        kind: 'genesis',
        first: {
          keyId: 'proof-key',
          publicKey: new Uint8Array(32).fill(1),
          signingPublicKey,
          label: 'proof',
        },
        recoveryPublicKey: ed25519.getPublicKey(new Uint8Array(32).fill(8)),
      },
      signer: signingPublicKey,
      at: 1,
    },
    privateKey,
  )
  const genesisHead = await appendMachineTrustLogEntry({
    ...tenant,
    expectedHead: null,
    entry: genesis,
  })
  const mintedId = succeeds(
    'postgres',
    'postgres',
    `SELECT id::text FROM machine_trust_log WHERE space_id = '${spaceA}' AND seq = 0;`,
  )
  expect(mintedId[14]).toBe('7')
  expect(['8', '9', 'a', 'b']).toContain(mintedId[19]!.toLowerCase())
  expect(() =>
    succeeds(
      'postgres',
      'postgres',
      `INSERT INTO machine_trust_log (id, space_id, seq, hash, prev_hash, entry, created_at) VALUES (gen_random_uuid(), '${spaceA}', 1, decode('${'11'.repeat(32)}', 'hex'), NULL, decode('00', 'hex'), now());`,
    ),
  ).toThrow(/machine_trust_log_prev_hash_check/)
  const add = signTrustLogEntry(
    {
      prev: genesisHead,
      space: spaceA,
      body: {
        kind: 'add',
        keyId: 'proof-key-2',
        publicKey: new Uint8Array(32).fill(2),
        signingPublicKey: ed25519.getPublicKey(new Uint8Array(32).fill(9)),
        label: 'proof-2',
      },
      signer: signingPublicKey,
      at: 2,
    },
    privateKey,
  )
  await expect(
    appendMachineTrustLogEntry({ ...tenant, expectedHead: genesisHead, entry: add }),
  ).resolves.toEqual(trustLogEntryHash(add))
  await expect(
    appendMachineTrustLogEntry({ ...tenant, expectedHead: genesisHead, entry: add }),
  ).rejects.toMatchObject({ status: 409 })
  await expect(
    appendMachineTrustLogEntry({
      ...tenant,
      spaceId: spaceB,
      expectedHead: null,
      entry: genesis,
    }),
  ).rejects.toMatchObject({ status: 400 })
  await expect(readMachineTrustLog(tenant)).resolves.toEqual([genesis, add])
}
