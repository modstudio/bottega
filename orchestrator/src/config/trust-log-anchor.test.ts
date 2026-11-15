import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type ConfigClient, ConfigClientError } from '../../../shared/config-client.ts'
import { CONFIG_HOME_ENV } from '../../../shared/config-directory.ts'
import { machineKeyId } from '../../../shared/machine-key-id.ts'
import { writeMachineKey } from '../../../shared/machine-key-store.ts'
import { writeMachineSigningKey } from '../../../shared/machine-signing-key.ts'
import { generateMachineKeyPair } from '../../../shared/secret-envelope.ts'
import { pinTrustedMachine } from '../../../shared/trust-list.ts'
import {
  decodeTrustLogEntry,
  trustLogEntryHash,
  verifyTrustLog,
} from '../../../shared/trust-log.ts'
import { machineAnchor, machineRecover } from './trust-log-anchor.ts'

const space = { spaceId: '01990000-0000-7000-8000-000000000001', slug: 'fixture' }

function environment() {
  return {
    [CONFIG_HOME_ENV]: mkdtempSync(join(tmpdir(), 'trust-log-anchor-')),
    BOTTEGA_KEYSTORE: 'file',
  }
}

async function identity(env: ReturnType<typeof environment>, value: number, label: string) {
  const pair = await generateMachineKeyPair()
  const signingPrivateKey = new Uint8Array(32).fill(value + 30)
  const signingPublicKey = ed25519.getPublicKey(signingPrivateKey)
  writeMachineKey(pair, env)
  writeMachineSigningKey({ privateKey: signingPrivateKey, publicKey: signingPublicKey }, env)
  return {
    keyId: await machineKeyId(pair.publicKey),
    publicKey: pair.publicKey,
    signingPublicKey,
    label,
  }
}

const listed = (key: Awaited<ReturnType<typeof identity>>, revokedAt: string | null = null) => ({
  keyId: key.keyId,
  publicKey: Buffer.from(key.publicKey).toString('base64url'),
  signingPublicKey: key.signingPublicKey,
  label: key.label,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  revokedAt,
  userId: 'user-a',
})

function client(entries: Uint8Array[], registered: ReturnType<typeof listed>[], conflict = false) {
  let appendCount = 0
  return {
    appendCount: () => appendCount,
    value: {
      whoami: async () => ({ user: { id: 'user-a' }, memberships: [] }),
      listMachineKeys: async () => registered,
      readTrustLog: async () => [...entries],
      appendTrustLogEntry: async (_head: Uint8Array | null, entry: Uint8Array) => {
        appendCount += 1
        if (conflict) throw new ConfigClientError('response', '/v1/config/trust-log', 409)
        entries.push(entry)
        return trustLogEntryHash(entry)
      },
    } as unknown as ConfigClient,
  }
}

const tty = { inputIsTTY: true, outputIsTTY: true }

test('anchor refuses non-terminals and a declined confirmation appends nothing and wipes the seed', async () => {
  const env = environment()
  const own = await identity(env, 1, 'own')
  const record = client([], [listed(own)])
  const common = { client: record.value, env, output: () => undefined, confirm: async () => false }
  await expect(
    machineAnchor(space, { ...common, inputIsTTY: false, outputIsTTY: true }),
  ).rejects.toThrow(
    'machine anchor requires stdin and stdout to be terminals; run it in your own terminal, not through an agent',
  )
  await expect(
    machineRecover(space, {
      client: record.value,
      env,
      inputIsTTY: true,
      outputIsTTY: false,
      output: () => undefined,
      promptWords: async () => '',
    }),
  ).rejects.toThrow(
    'machine recover requires stdin and stdout to be terminals; run it in your own terminal, not through an agent',
  )
  await expect(
    machineRecover(space, {
      client: record.value,
      env,
      ...tty,
      output: () => undefined,
      promptWords: async () => '',
    }),
  ).rejects.toThrow(
    `space fixture is not anchored; run \`${PLATFORM_SLUG} machine anchor --space fixture\``,
  )
  const seed = new Uint8Array(32).fill(7)
  await expect(machineAnchor(space, { ...common, ...tty, randomSeed: () => seed })).rejects.toThrow(
    'recovery words were not confirmed; nothing was changed',
  )
  expect(record.appendCount()).toBe(0)
  expect([...seed]).toEqual(new Array(32).fill(0))
})

test('anchor prints recoverable words and migrates only agreeing active pinned keys', async () => {
  const env = environment()
  const own = await identity(env, 2, 'own')
  const good = { ...(await identity(environment(), 3, 'good')) }
  const revoked = { ...(await identity(environment(), 4, 'revoked')) }
  await pinTrustedMachine(good.keyId, good.publicKey, good.label, env)
  await pinTrustedMachine(revoked.keyId, revoked.publicKey, revoked.label, env)
  const entries: Uint8Array[] = []
  const record = client(entries, [
    listed(own),
    listed(good),
    listed(revoked, new Date().toISOString()),
  ])
  const output: string[] = []
  const originalSeed = new Uint8Array(32).fill(9)
  const seed = originalSeed.slice()
  const before = readdirSync(env[CONFIG_HOME_ENV]!).sort()
  await machineAnchor(space, {
    client: record.value,
    env,
    ...tty,
    output: (line) => output.push(line),
    confirm: async () => true,
    randomSeed: () => seed,
    at: 1,
  })
  const state = verifyTrustLog(entries, { spaceId: space.spaceId })
  expect([...state.keys.keys()].sort()).toEqual([good.keyId, own.keyId].sort())
  expect(output[0]!.split(' ')).toHaveLength(24)
  expect(mnemonicToEntropy(output[0]!, wordlist)).toEqual(originalSeed)
  expect(state.recoveryPublicKey).toEqual(ed25519.getPublicKey(originalSeed))
  expect(readdirSync(env[CONFIG_HOME_ENV]!).sort()).toEqual([...before, 'trust-log-heads'].sort())
  expect([...seed]).toEqual(new Array(32).fill(0))
})

test('anchor reports genesis contention, follows an existing log, and refuses an untrusted follower', async () => {
  const env = environment()
  const own = await identity(env, 5, 'own')
  const conflict = client([], [listed(own)], true)
  await expect(
    machineAnchor(space, {
      client: conflict.value,
      env,
      ...tty,
      output: () => undefined,
      confirm: async () => true,
      randomSeed: () => new Uint8Array(32).fill(8),
    }),
  ).rejects.toThrow(
    `another machine anchored this space; discard the words shown and run \`${PLATFORM_SLUG} machine anchor\` again to add your pinned keys`,
  )

  const entries: Uint8Array[] = []
  const record = client(entries, [listed(own)])
  await machineAnchor(space, {
    client: record.value,
    env,
    ...tty,
    output: () => undefined,
    confirm: async () => true,
    randomSeed: () => new Uint8Array(32).fill(10),
  })
  const follower = { ...(await identity(environment(), 6, 'follower')) }
  await pinTrustedMachine(follower.keyId, follower.publicKey, follower.label, env)
  record.value.listMachineKeys = async () => [listed(own), listed(follower)]
  await machineAnchor(space, {
    client: record.value,
    env,
    ...tty,
    output: () => undefined,
    confirm: async () => true,
  })
  expect(verifyTrustLog(entries, { spaceId: space.spaceId }).keys.has(follower.keyId)).toBe(true)
  const noOpOutput: string[] = []
  await machineAnchor(space, {
    client: record.value,
    env,
    ...tty,
    output: (line) => noOpOutput.push(line),
    confirm: async () => true,
  })
  expect(noOpOutput).toEqual(['space fixture is already anchored; nothing was added'])

  const outsiderEnv = environment()
  const outsider = await identity(outsiderEnv, 7, 'outsider')
  record.value.listMachineKeys = async () => [listed(outsider)]
  await expect(
    machineAnchor(space, {
      client: record.value,
      env: outsiderEnv,
      ...tty,
      output: () => undefined,
      confirm: async () => true,
    }),
  ).rejects.toThrow(
    `this machine is not trusted by the space machine trust log; run \`${PLATFORM_SLUG} machine join --space fixture\``,
  )
})

test('recover adds this machine with the recovery signature and rejects invalid or wrong words', async () => {
  const anchorEnv = environment()
  const anchor = await identity(anchorEnv, 8, 'anchor')
  const entries: Uint8Array[] = []
  const anchorClient = client(entries, [listed(anchor)])
  const entropy = new Uint8Array(32).fill(12)
  await machineAnchor(space, {
    client: anchorClient.value,
    env: anchorEnv,
    ...tty,
    output: () => undefined,
    confirm: async () => true,
    randomSeed: () => entropy.slice(),
  })

  const recoverEnv = environment()
  const recovered = await identity(recoverEnv, 9, 'recovered')
  const recoverClient = client(entries, [listed(recovered)])
  await expect(
    machineRecover(space, {
      client: recoverClient.value,
      env: recoverEnv,
      ...tty,
      output: () => undefined,
      promptWords: async () => 'abandon '.repeat(24),
    }),
  ).rejects.toThrow('recovery words have an invalid BIP39 checksum')
  await expect(
    machineRecover(space, {
      client: recoverClient.value,
      env: recoverEnv,
      ...tty,
      output: () => undefined,
      promptWords: async () => entropyToMnemonic(new Uint8Array(16).fill(13), wordlist),
    }),
  ).rejects.toThrow("recovery words do not match this space's recovery key")
  expect(recoverClient.appendCount()).toBe(0)
  await expect(
    machineRecover(space, {
      client: recoverClient.value,
      env: recoverEnv,
      ...tty,
      output: () => undefined,
      promptWords: async () => entropyToMnemonic(new Uint8Array(32).fill(13), wordlist),
    }),
  ).rejects.toThrow("recovery words do not match this space's recovery key")
  await machineRecover(space, {
    client: recoverClient.value,
    env: recoverEnv,
    ...tty,
    output: () => undefined,
    promptWords: async () => `  ${entropyToMnemonic(entropy, wordlist).toUpperCase()}  `,
  })
  const state = verifyTrustLog(entries, { spaceId: space.spaceId })
  expect(state.keys.has(recovered.keyId)).toBe(true)
  expect(decodeTrustLogEntry(entries.at(-1)!).signer).toEqual(state.recoveryPublicKey)
  const output: string[] = []
  await machineRecover(space, {
    client: recoverClient.value,
    env: recoverEnv,
    ...tty,
    output: (line) => output.push(line),
    promptWords: async () => '',
  })
  expect(output).toEqual([
    'this machine is already trusted by the space machine trust log; nothing was added',
  ])
})
