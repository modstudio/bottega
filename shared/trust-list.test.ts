import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { machineKeyId } from './machine-key-id.ts'
import { generateMachineKeyPair } from './secret-envelope.ts'
import { pinTrustedMachine, readTrustList, trustListPath } from './trust-list.ts'

test('trust list validates that every key id matches its public key', async () => {
  const env = { BOTTEGA_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'trust-list-')) }
  const pair = await generateMachineKeyPair()
  const keyId = await machineKeyId(pair.publicKey)
  await pinTrustedMachine(keyId, pair.publicKey, 'self', env)
  expect((await readTrustList(env))[keyId]?.label).toBe('self')
  writeFileSync(
    trustListPath(env),
    `["AAAAAAAAAAAAAAAAAAAAAA"]\npublic_key = "${Buffer.from(pair.publicKey).toString('base64url')}"\nlabel = "wrong"\npinned_at = "2026-09-18T12:00:00.000Z"\n`,
  )
  await expect(readTrustList(env)).rejects.toThrow('does not match its public key')
})
