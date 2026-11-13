// concern: machine join and approval exchange

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type ConfigClient, ConfigClientError } from '../../../shared/config-client.ts'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import { CpaceRefusal } from '../../../shared/cpace.ts'
import {
  decodeMachineJoinDone,
  decodeMachineJoinRecord,
  encodeMachineJoinDone,
  encodeMachineJoinRecord,
  MACHINE_JOIN_TAG_BYTES,
  type MachineJoinSession,
  makeMachineJoinTag,
  openMachineJoinMessage,
  sealMachineJoinMessage,
  startMachineJoin,
  verifyMachineJoinTag,
} from '../../../shared/machine-join-protocol.ts'
import { machineKeyId } from '../../../shared/machine-key-id.ts'
import { readMachineKey } from '../../../shared/machine-key-store.ts'
import { readMachineSigningKey } from '../../../shared/machine-signing-key.ts'
import {
  formatPairingCode,
  generatePairingCode,
  type PairingCode,
  parsePairingCode,
} from '../../../shared/pairing-code.ts'
import { pinTrustedMachine } from '../../../shared/trust-list.ts'
import { bytesEqual, type TrustLogKey, verifyTrustLog } from '../../../shared/trust-log.ts'
import {
  readRememberedTrustLogHead,
  writeRememberedTrustLogHead,
} from '../../../shared/trust-log-head.ts'
import { machineTrust } from './config-service.ts'
import { encoded } from './data-key-access.ts'
import { appendSignedTrustLogEntry } from './trust-log-append.ts'

export const MACHINE_JOIN_POLL_MS = 2_000
type SelectedSpace = { spaceId: string; slug: string }
type Ports = {
  client: ConfigClient
  env: ConfigEnvironment
  at?: () => number
  pollMs?: number
  signal?: AbortSignal
  output?: (line: string) => void
}
type RelayMessage = { side: string; phase: string; body: Uint8Array }

const sideText = (side: Uint8Array) => Buffer.from(side).toString('hex')
const sideBytes = (side: string) => new Uint8Array(Buffer.from(side, 'hex'))
const concat = (...values: Uint8Array[]) =>
  new Uint8Array(Buffer.concat(values.map((value) => Buffer.from(value))))

function expirationRefusal(): Error {
  return new Error(`pairing code expired; start again with \`${PLATFORM_SLUG} machine join\``)
}

function relayRefusal(error: unknown): never {
  if (error instanceof ConfigClientError && error.status === 410)
    throw new Error(
      `the pairing exchange failed or expired; start again with \`${PLATFORM_SLUG} machine join\` on the new machine`,
    )
  throw error
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

async function poll(
  ports: Ports,
  nameplate: string,
  side: string,
  expiresAt: string,
  phases: readonly string[],
  destination: { destinationSpaceId: string },
): Promise<Map<string, RelayMessage>> {
  const found = new Map<string, RelayMessage>()
  while (found.size !== phases.length) {
    if ((ports.at?.() ?? Date.now()) >= new Date(expiresAt).getTime()) throw expirationRefusal()
    let mailbox: Awaited<ReturnType<ConfigClient['readMachineJoinMessages']>>
    try {
      mailbox = await ports.client.readMachineJoinMessages(nameplate, side, destination)
    } catch (error) {
      relayRefusal(error)
    }
    for (const message of mailbox.messages)
      if (phases.includes(message.phase) && !found.has(message.phase))
        found.set(message.phase, message)
    if (found.size !== phases.length)
      await pause(ports.pollMs ?? MACHINE_JOIN_POLL_MS, ports.signal)
  }
  return found
}

async function localRecord(
  selected: SelectedSpace,
  ports: Ports,
): Promise<{ record: TrustLogKey; ownUserId: string }> {
  const pair = readMachineKey(ports.env)
  const signing = readMachineSigningKey(ports.env)
  if (!pair || !signing)
    throw new Error(
      `machine key is not initialized; run \`${PLATFORM_SLUG} machine config machine init --space ${selected.slug}\``,
    )
  const keyId = await machineKeyId(pair.publicKey)
  const [who, machines] = await Promise.all([
    ports.client.whoami(),
    ports.client.listMachineKeys({ destinationSpaceId: selected.spaceId }),
  ])
  const registered = machines.find((machine) => machine.keyId === keyId)
  if (
    !registered ||
    registered.revokedAt !== null ||
    registered.userId !== who.user.id ||
    !registered.signingPublicKey ||
    !bytesEqual(
      registered.publicKey
        ? new Uint8Array(Buffer.from(registered.publicKey, 'base64url'))
        : pair.publicKey,
      pair.publicKey,
    ) ||
    !bytesEqual(registered.signingPublicKey, signing.publicKey)
  )
    throw new Error(
      `machine key is not registered for this user; run \`${PLATFORM_SLUG} machine config machine init --space ${selected.slug}\``,
    )
  return {
    ownUserId: who.user.id,
    record: {
      keyId,
      publicKey: pair.publicKey,
      signingPublicKey: signing.publicKey,
      label: registered.label,
    },
  }
}

async function burn(ports: Ports, nameplate: string, side: string): Promise<void> {
  await ports.client.failMachineJoinNameplate(nameplate, side).catch(() => undefined)
}

const mismatch = () =>
  new Error(`the pairing code did not match; start again with \`${PLATFORM_SLUG} machine join\``)

export async function machineJoin(
  selected: SelectedSpace,
  ports: Ports,
): Promise<{ label: string; keyId: string }> {
  const { record } = await localRecord(selected, ports)
  const destination = { destinationSpaceId: selected.spaceId }
  const entries = await ports.client.readTrustLog(destination)
  const remembered = readRememberedTrustLogHead(selected.spaceId, ports.env)
  const initial = entries.length
    ? verifyTrustLog(entries, { spaceId: selected.spaceId, rememberedHead: remembered })
    : null
  if (initial?.keys.has(record.keyId)) throw new Error('this machine is already approved')
  const allocated = await ports.client.allocateMachineJoinNameplate(destination)
  const code = generatePairingCode(allocated.nameplate)
  const formatted = formatPairingCode(code)
  ports.output?.(formatted)
  ports.output?.(`on an approved machine run: \`${PLATFORM_SLUG} machine approve ${formatted}\``)
  const party = startMachineJoin(code, selected.spaceId, allocated.expiresAt, 'joiner')
  const ownSide = sideText(party.side)
  await ports.client.postMachineJoinMessage(
    allocated.nameplate,
    ownSide,
    'pake-a',
    party.share,
    destination,
  )
  const incoming = await poll(
    ports,
    allocated.nameplate,
    ownSide,
    allocated.expiresAt,
    ['pake-b', 'confirm-b'],
    destination,
  )
  const pake = incoming.get('pake-b')!
  const confirmation = incoming.get('confirm-b')!
  let session: MachineJoinSession
  try {
    session = party.finish(pake.body, sideBytes(pake.side))
  } catch (error) {
    if (error instanceof CpaceRefusal) {
      await burn(ports, allocated.nameplate, ownSide)
      throw mismatch()
    }
    throw error
  }
  const tag = confirmation.body.slice(0, MACHINE_JOIN_TAG_BYTES)
  if (!verifyMachineJoinTag(session, 'approver', tag)) {
    await burn(ports, allocated.nameplate, ownSide)
    throw mismatch()
  }
  const approver = decodeMachineJoinRecord(
    openMachineJoinMessage(
      session,
      'approver',
      selected.spaceId,
      allocated.nameplate,
      'confirm-b',
      confirmation.body.slice(MACHINE_JOIN_TAG_BYTES),
    ),
  )
  if ((await machineKeyId(approver.publicKey)) !== approver.keyId) {
    await burn(ports, allocated.nameplate, ownSide)
    throw new Error('the approving machine key id does not match its confirmed public key')
  }
  const trustedApprover = initial?.keys.get(approver.keyId)
  if (
    initial &&
    (!trustedApprover ||
      !bytesEqual(trustedApprover.publicKey, approver.publicKey) ||
      !bytesEqual(trustedApprover.signingPublicKey, approver.signingPublicKey))
  ) {
    await burn(ports, allocated.nameplate, ownSide)
    throw new Error('the approving machine is not trusted by the space machine trust log')
  }
  const confirmA = concat(
    makeMachineJoinTag(session, 'joiner'),
    sealMachineJoinMessage(
      session,
      'joiner',
      selected.spaceId,
      allocated.nameplate,
      'confirm-a',
      encodeMachineJoinRecord(record),
    ),
  )
  await ports.client.postMachineJoinMessage(
    allocated.nameplate,
    ownSide,
    'confirm-a',
    confirmA,
    destination,
  )
  const done = (
    await poll(ports, allocated.nameplate, ownSide, allocated.expiresAt, ['done'], destination)
  ).get('done')!
  const head = decodeMachineJoinDone(
    openMachineJoinMessage(
      session,
      'approver',
      selected.spaceId,
      allocated.nameplate,
      'done',
      done.body,
    ),
  )
  await pinTrustedMachine(approver.keyId, approver.publicKey, approver.label, ports.env)
  if (head) {
    const finalEntries = await ports.client.readTrustLog(destination)
    const state = verifyTrustLog(finalEntries, {
      spaceId: selected.spaceId,
      rememberedHead: remembered,
    })
    const own = state.keys.get(record.keyId)
    if (
      !own ||
      !bytesEqual(own.publicKey, record.publicKey) ||
      !bytesEqual(own.signingPublicKey, record.signingPublicKey)
    )
      throw new Error('the approved machine is absent from the verified machine trust log')
    if (!bytesEqual(state.head, head))
      throw new Error('the approval head differs from the record trust-log head')
    writeRememberedTrustLogHead(selected.spaceId, state.head, ports.env)
  }
  return { label: approver.label, keyId: approver.keyId }
}

export async function machineApprove(
  codeText: string,
  selected: SelectedSpace,
  ports: Ports,
): Promise<{ label: string; keyId: string }> {
  const code: PairingCode = parsePairingCode(codeText)
  const { record } = await localRecord(selected, ports)
  const destination = { destinationSpaceId: selected.spaceId }
  const entries = await ports.client.readTrustLog(destination)
  const remembered = readRememberedTrustLogHead(selected.spaceId, ports.env)
  const initial = entries.length
    ? verifyTrustLog(entries, { spaceId: selected.spaceId, rememberedHead: remembered })
    : null
  if (initial && !initial.keys.has(record.keyId))
    throw new Error(
      `this machine is not trusted by the space machine trust log; have an owner approve it from an approved machine before retrying \`${PLATFORM_SLUG} machine config machine revoke\``,
    )
  const side = crypto.getRandomValues(new Uint8Array(16))
  const ownSide = sideText(side)
  let first: Awaited<ReturnType<ConfigClient['readMachineJoinMessages']>>
  try {
    first = await ports.client.readMachineJoinMessages(code.nameplate, ownSide, destination)
  } catch (error) {
    relayRefusal(error)
  }
  const pakeA =
    first.messages.find((message) => message.phase === 'pake-a') ??
    (await poll(ports, code.nameplate, ownSide, first.expiresAt, ['pake-a'], destination)).get(
      'pake-a',
    )!
  const party = startMachineJoin(code, selected.spaceId, first.expiresAt, 'approver', side)
  let session: MachineJoinSession
  try {
    session = party.finish(pakeA.body, sideBytes(pakeA.side))
  } catch (error) {
    if (error instanceof CpaceRefusal) {
      await burn(ports, code.nameplate, ownSide)
      throw mismatch()
    }
    throw error
  }
  await ports.client.postMachineJoinMessage(
    code.nameplate,
    ownSide,
    'pake-b',
    party.share,
    destination,
  )
  await ports.client.postMachineJoinMessage(
    code.nameplate,
    ownSide,
    'confirm-b',
    concat(
      makeMachineJoinTag(session, 'approver'),
      sealMachineJoinMessage(
        session,
        'approver',
        selected.spaceId,
        code.nameplate,
        'confirm-b',
        encodeMachineJoinRecord(record),
      ),
    ),
    destination,
  )
  const confirm = (
    await poll(ports, code.nameplate, ownSide, first.expiresAt, ['confirm-a'], destination)
  ).get('confirm-a')!
  if (!verifyMachineJoinTag(session, 'joiner', confirm.body.slice(0, MACHINE_JOIN_TAG_BYTES))) {
    await burn(ports, code.nameplate, ownSide)
    throw mismatch()
  }
  const joiner = decodeMachineJoinRecord(
    openMachineJoinMessage(
      session,
      'joiner',
      selected.spaceId,
      code.nameplate,
      'confirm-a',
      confirm.body.slice(MACHINE_JOIN_TAG_BYTES),
    ),
  )
  const registered = (await ports.client.listMachineKeys(destination)).find(
    (key) => key.keyId === joiner.keyId,
  )
  if (
    (await machineKeyId(joiner.publicKey)) !== joiner.keyId ||
    !registered ||
    registered.revokedAt !== null ||
    !registered.signingPublicKey ||
    !bytesEqual(new Uint8Array(Buffer.from(registered.publicKey, 'base64url')), joiner.publicKey) ||
    !bytesEqual(registered.signingPublicKey, joiner.signingPublicKey)
  ) {
    await burn(ports, code.nameplate, ownSide)
    throw new Error(
      `the record's registered key for ${joiner.keyId} differs from the key the joining machine confirmed; do not trust this record, and report it`,
    )
  }
  let head: Uint8Array | null = null
  if (initial)
    head = await appendSignedTrustLogEntry(
      ports.client,
      record.keyId,
      selected.spaceId,
      { kind: 'add', ...joiner },
      'machine approve',
      { at: ports.at?.(), env: ports.env },
    )
  try {
    await machineTrust(
      joiner.keyId,
      encoded(joiner.publicKey),
      joiner.label,
      selected,
      ports.client,
      ports.env,
    )
  } catch (error) {
    if (head)
      throw new Error(
        `machine ${joiner.keyId} was approved but wrapping its data key failed; finish with \`${PLATFORM_SLUG} machine config machine trust ${joiner.keyId} ${encoded(joiner.publicKey)} --yes\``,
        { cause: error },
      )
    throw error
  }
  await ports.client.postMachineJoinMessage(
    code.nameplate,
    ownSide,
    'done',
    sealMachineJoinMessage(
      session,
      'approver',
      selected.spaceId,
      code.nameplate,
      'done',
      encodeMachineJoinDone(head),
    ),
    destination,
  )
  return { label: joiner.label, keyId: joiner.keyId }
}
