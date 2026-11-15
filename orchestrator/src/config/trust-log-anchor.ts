// concern: interactive trust-log anchoring and recovery

import { ed25519 } from '@noble/curves/ed25519.js'
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type ConfigClient, ConfigClientError } from '../../../shared/config-client.ts'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import { machineKeyId } from '../../../shared/machine-key-id.ts'
import { readMachineKey } from '../../../shared/machine-key-store.ts'
import { readMachineSigningKey } from '../../../shared/machine-signing-key.ts'
import { readTrustList, type TrustList } from '../../../shared/trust-list.ts'
import {
  bytesEqual,
  signTrustLogEntry,
  type TrustLogBody,
  type TrustLogKey,
  type TrustState,
  verifyTrustLog,
} from '../../../shared/trust-log.ts'
import { writeRememberedTrustLogHead } from '../../../shared/trust-log-head.ts'
import { verifiedTrustLogForSpace } from '../../../shared/trust-log-keys.ts'
import { registeredKeyAgrees } from './machine-join.ts'

type SelectedSpace = { spaceId: string; slug: string }
type RegisteredKey = Awaited<ReturnType<ConfigClient['listMachineKeys']>>[number]
type CommonPorts = {
  client: ConfigClient
  env: ConfigEnvironment
  inputIsTTY: boolean
  outputIsTTY: boolean
  output: (line: string) => void
  at?: number
}
type AnchorPorts = CommonPorts & {
  confirm: () => Promise<boolean>
  randomSeed?: () => Uint8Array
}
type RecoverPorts = CommonPorts & { promptWords: () => Promise<string> }

type AnchorDecision =
  | { action: 'refuse'; message: string }
  | { action: 'already' }
  | { action: 'append'; keys: TrustLogKey[] }

function registeredTrustKey(registered: RegisteredKey, label: string): TrustLogKey | null {
  if (!registered.publicKey || !registered.signingPublicKey) return null
  return {
    keyId: registered.keyId,
    publicKey: new Uint8Array(Buffer.from(registered.publicKey, 'base64url')),
    signingPublicKey: registered.signingPublicKey,
    label,
  }
}

function decideAnchor(
  slug: string,
  state: TrustState | null,
  own: TrustLogKey,
  pins: TrustList,
  registered: RegisteredKey[],
): AnchorDecision {
  if (state && !state.keys.has(own.keyId))
    return {
      action: 'refuse',
      message: `this machine is not trusted by the space machine trust log; run \`${PLATFORM_SLUG} machine join --space ${slug}\``,
    }
  const keys = Object.entries(pins).flatMap(([keyId, pin]) => {
    if (keyId === own.keyId || state?.keys.has(keyId)) return []
    const listed = registered.find((candidate) => candidate.keyId === keyId)
    if (!listed) return []
    const key = registeredTrustKey(listed, pin.label)
    if (
      !key ||
      !bytesEqual(key.publicKey, new Uint8Array(Buffer.from(pin.public_key, 'base64url'))) ||
      !registeredKeyAgrees(listed, key)
    )
      return []
    return [key]
  })
  return state && keys.length === 0 ? { action: 'already' } : { action: 'append', keys }
}

function requireTerminal(verb: 'anchor' | 'recover', ports: CommonPorts): void {
  if (!ports.inputIsTTY || !ports.outputIsTTY)
    throw new Error(
      `machine ${verb} requires stdin and stdout to be terminals; run it in your own terminal, not through an agent`,
    )
}

async function localRecord(
  selected: SelectedSpace,
  ports: CommonPorts,
): Promise<{ own: TrustLogKey; signingPrivateKey: Uint8Array; registered: RegisteredKey[] }> {
  const pair = readMachineKey(ports.env)
  const signing = readMachineSigningKey(ports.env)
  if (!pair || !signing)
    throw new Error(
      `machine key is not initialized; run \`${PLATFORM_SLUG} machine config machine init --space ${selected.slug}\``,
    )
  const keyId = await machineKeyId(pair.publicKey)
  const [who, registered] = await Promise.all([
    ports.client.whoami(),
    ports.client.listMachineKeys({ destinationSpaceId: selected.spaceId }),
  ])
  const listed = registered.find((candidate) => candidate.keyId === keyId)
  const own: TrustLogKey = {
    keyId,
    publicKey: pair.publicKey,
    signingPublicKey: signing.publicKey,
    label: listed?.label ?? '',
  }
  if (listed?.userId !== who.user.id || !registeredKeyAgrees(listed, own))
    throw new Error(
      `machine key is not registered for this user; run \`${PLATFORM_SLUG} machine config machine init --space ${selected.slug}\``,
    )
  return { own, signingPrivateKey: signing.privateKey, registered }
}

async function append(
  selected: SelectedSpace,
  ports: CommonPorts,
  entries: Uint8Array[],
  state: TrustState | null,
  body: TrustLogBody,
  signer: Uint8Array,
  privateKey: Uint8Array,
  action: 'genesis' | 'anchor' | 'recover',
): Promise<{ entries: Uint8Array[]; state: TrustState }> {
  const encoded = signTrustLogEntry(
    {
      prev: state?.head ?? null,
      space: selected.spaceId,
      body,
      signer,
      at: ports.at ?? Date.now(),
    },
    privateKey,
  )
  const nextEntries = [...entries, encoded]
  const nextState = verifyTrustLog(nextEntries, {
    spaceId: selected.spaceId,
    rememberedHead: state?.head ?? null,
  })
  try {
    await ports.client.appendTrustLogEntry(state?.head ?? null, encoded, {
      destinationSpaceId: selected.spaceId,
    })
  } catch (error) {
    if (error instanceof ConfigClientError && error.status === 409) {
      if (action === 'genesis')
        throw new Error(
          `another machine anchored this space; discard the words shown and run \`${PLATFORM_SLUG} machine anchor\` again to add your pinned keys`,
        )
      throw new Error(
        `machine trust log changed while running ${PLATFORM_SLUG} machine ${action}; retry \`${PLATFORM_SLUG} machine ${action}\``,
      )
    }
    throw error
  }
  writeRememberedTrustLogHead(selected.spaceId, nextState.head, ports.env)
  return { entries: nextEntries, state: nextState }
}

export async function machineAnchor(selected: SelectedSpace, ports: AnchorPorts): Promise<void> {
  requireTerminal('anchor', ports)
  const [{ entries, state: initial }, local, pins] = await Promise.all([
    verifiedTrustLogForSpace(ports.client, selected.spaceId, ports.env),
    localRecord(selected, ports),
    readTrustList(ports.env),
  ])
  const decision = decideAnchor(selected.slug, initial, local.own, pins, local.registered)
  if (decision.action === 'refuse') throw new Error(decision.message)
  if (decision.action === 'already') {
    ports.output(`space ${selected.slug} is already anchored; nothing was added`)
    return
  }
  let currentEntries = entries
  let currentState = initial
  let seed: Uint8Array | null = null
  try {
    if (!currentState) {
      seed = ports.randomSeed?.() ?? crypto.getRandomValues(new Uint8Array(32))
      if (seed.byteLength !== 32) throw new Error('recovery seed source must return 32 bytes')
      ports.output(entropyToMnemonic(seed, wordlist))
      if (!(await ports.confirm()))
        throw new Error('recovery words were not confirmed; nothing was changed')
      const appended = await append(
        selected,
        ports,
        currentEntries,
        null,
        { kind: 'genesis', first: local.own, recoveryPublicKey: ed25519.getPublicKey(seed) },
        local.own.signingPublicKey,
        local.signingPrivateKey,
        'genesis',
      )
      currentEntries = appended.entries
      currentState = appended.state
    }
    for (const key of decision.keys) {
      const appended = await append(
        selected,
        ports,
        currentEntries,
        currentState,
        { kind: 'add', ...key },
        local.own.signingPublicKey,
        local.signingPrivateKey,
        'anchor',
      )
      currentEntries = appended.entries
      currentState = appended.state
    }
  } finally {
    seed?.fill(0)
  }
}

const normalizedMnemonic = (words: string) =>
  words.trim().toLowerCase().split(/\s+/u).filter(Boolean).join(' ')

export async function machineRecover(selected: SelectedSpace, ports: RecoverPorts): Promise<void> {
  requireTerminal('recover', ports)
  const { entries, state } = await verifiedTrustLogForSpace(
    ports.client,
    selected.spaceId,
    ports.env,
  )
  if (!state)
    throw new Error(
      `space ${selected.slug} is not anchored; run \`${PLATFORM_SLUG} machine anchor --space ${selected.slug}\``,
    )
  const { own } = await localRecord(selected, ports)
  if (state.keys.has(own.keyId)) {
    ports.output(
      'this machine is already trusted by the space machine trust log; nothing was added',
    )
    return
  }
  const words = normalizedMnemonic(await ports.promptWords())
  if (!validateMnemonic(words, wordlist))
    throw new Error('recovery words have an invalid BIP39 checksum')
  const seed = mnemonicToEntropy(words, wordlist)
  try {
    if (seed.byteLength !== 32)
      throw new Error("recovery words do not match this space's recovery key")
    const recoveryPublicKey = ed25519.getPublicKey(seed)
    if (!bytesEqual(recoveryPublicKey, state.recoveryPublicKey))
      throw new Error("recovery words do not match this space's recovery key")
    await append(
      selected,
      ports,
      entries,
      state,
      { kind: 'add', ...own },
      recoveryPublicKey,
      seed,
      'recover',
    )
  } finally {
    seed.fill(0)
  }
}
