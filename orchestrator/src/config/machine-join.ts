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

const MACHINE_JOIN_POLL_MS = 2_000
type SelectedSpace = { spaceId: string; slug: string }
type Ports = {
  client: ConfigClient
  env: ConfigEnvironment
  at?: number | (() => number)
  pollMs?: number
  signal?: AbortSignal
  output?: (line: string) => void
}
type RelayMessage = { side: string; phase: string; body: Uint8Array }

const now = (at: Ports['at']) => (typeof at === 'function' ? at() : (at ?? Date.now()))

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
    if (now(ports.at) >= new Date(expiresAt).getTime()) throw expirationRefusal()
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
    !registered.publicKey ||
    !registered.signingPublicKey ||
    !bytesEqual(new Uint8Array(Buffer.from(registered.publicKey, 'base64url')), pair.publicKey) ||
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

async function burn(
  ports: Ports,
  selected: SelectedSpace,
  nameplate: string,
  side: string,
): Promise<void> {
  await ports.client
    .failMachineJoinNameplate(nameplate, side, { destinationSpaceId: selected.spaceId })
    .catch(() => undefined)
}

const mismatch = () =>
  new Error(`the pairing code did not match; start again with \`${PLATFORM_SLUG} machine join\``)

async function verifiedApprover(
  session: MachineJoinSession,
  confirmation: RelayMessage,
  selected: SelectedSpace,
  nameplate: string,
  ownSide: string,
  initial: ReturnType<typeof verifyTrustLog> | null,
  ports: Ports,
): Promise<TrustLogKey> {
  if (
    !verifyMachineJoinTag(session, 'approver', confirmation.body.slice(0, MACHINE_JOIN_TAG_BYTES))
  ) {
    await burn(ports, selected, nameplate, ownSide)
    throw mismatch()
  }
  const approver = decodeMachineJoinRecord(
    openMachineJoinMessage(
      session,
      'approver',
      selected.spaceId,
      nameplate,
      'confirm-b',
      confirmation.body.slice(MACHINE_JOIN_TAG_BYTES),
    ),
  )
  const trusted = initial?.keys.get(approver.keyId)
  if (
    (await machineKeyId(approver.publicKey)) !== approver.keyId ||
    (initial &&
      (!trusted ||
        !bytesEqual(trusted.publicKey, approver.publicKey) ||
        !bytesEqual(trusted.signingPublicKey, approver.signingPublicKey)))
  ) {
    await burn(ports, selected, nameplate, ownSide)
    throw new Error('the approving machine is not trusted by the space machine trust log')
  }
  return approver
}

async function acceptDone(
  done: RelayMessage,
  session: MachineJoinSession,
  selected: SelectedSpace,
  nameplate: string,
  approver: TrustLogKey,
  own: TrustLogKey,
  remembered: Uint8Array | null,
  ports: Ports,
): Promise<void> {
  const head = decodeMachineJoinDone(
    openMachineJoinMessage(session, 'approver', selected.spaceId, nameplate, 'done', done.body),
  )
  if (head) {
    const state = verifyTrustLog(
      await ports.client.readTrustLog({ destinationSpaceId: selected.spaceId }),
      { spaceId: selected.spaceId, rememberedHead: remembered },
    )
    const trustedOwn = state.keys.get(own.keyId)
    if (
      !trustedOwn ||
      !bytesEqual(trustedOwn.publicKey, own.publicKey) ||
      !bytesEqual(trustedOwn.signingPublicKey, own.signingPublicKey)
    )
      throw new Error('the approved machine is absent from the verified machine trust log')
    if (!bytesEqual(state.head, head))
      throw new Error('the approval head differs from the record trust-log head')
    writeRememberedTrustLogHead(selected.spaceId, state.head, ports.env)
  }
  await pinTrustedMachine(approver.keyId, approver.publicKey, approver.label, ports.env)
}

async function verifiedJoiner(
  confirm: RelayMessage,
  session: MachineJoinSession,
  selected: SelectedSpace,
  nameplate: string,
  ownSide: string,
  ports: Ports,
): Promise<TrustLogKey> {
  if (!verifyMachineJoinTag(session, 'joiner', confirm.body.slice(0, MACHINE_JOIN_TAG_BYTES))) {
    await burn(ports, selected, nameplate, ownSide)
    throw mismatch()
  }
  const joiner = decodeMachineJoinRecord(
    openMachineJoinMessage(
      session,
      'joiner',
      selected.spaceId,
      nameplate,
      'confirm-a',
      confirm.body.slice(MACHINE_JOIN_TAG_BYTES),
    ),
  )
  const registered = (
    await ports.client.listMachineKeys({ destinationSpaceId: selected.spaceId })
  ).find((key) => key.keyId === joiner.keyId)
  if (
    (await machineKeyId(joiner.publicKey)) !== joiner.keyId ||
    !registered ||
    registered.revokedAt !== null ||
    !registered.signingPublicKey ||
    !bytesEqual(new Uint8Array(Buffer.from(registered.publicKey, 'base64url')), joiner.publicKey) ||
    !bytesEqual(registered.signingPublicKey, joiner.signingPublicKey)
  ) {
    await burn(ports, selected, nameplate, ownSide)
    throw new Error(
      `the record's registered key for ${joiner.keyId} differs from the key the joining machine confirmed; do not trust this record, and report it`,
    )
  }
  return joiner
}

async function approveAndWrap(
  joiner: TrustLogKey,
  own: TrustLogKey,
  selected: SelectedSpace,
  initial: ReturnType<typeof verifyTrustLog> | null,
  ports: Ports,
): Promise<Uint8Array | null> {
  const head = initial
    ? await appendSignedTrustLogEntry(
        ports.client,
        own.keyId,
        selected.spaceId,
        { kind: 'add', ...joiner },
        'machine approve',
        { at: now(ports.at), env: ports.env },
      )
    : null
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
  return head
}

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
      await burn(ports, selected, allocated.nameplate, ownSide)
      throw mismatch()
    }
    throw error
  }
  const approver = await verifiedApprover(
    session,
    confirmation,
    selected,
    allocated.nameplate,
    ownSide,
    initial,
    ports,
  )
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
  await acceptDone(
    done,
    session,
    selected,
    allocated.nameplate,
    approver,
    record,
    remembered,
    ports,
  )
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
      `this machine is not trusted by the space machine trust log; have an owner approve it from an approved machine before retrying \`${PLATFORM_SLUG} machine approve\``,
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
      await burn(ports, selected, code.nameplate, ownSide)
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
  const joiner = await verifiedJoiner(confirm, session, selected, code.nameplate, ownSide, ports)
  const head = await approveAndWrap(joiner, record, selected, initial, ports)
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
