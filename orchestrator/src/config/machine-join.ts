// concern: machine join and approval exchange

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type ConfigClient, ConfigClientError } from '../../../shared/config-client.ts'
import type { ConfigEnvironment } from '../../../shared/config-directory.ts'
import {
  credentialMachineTrustCommands,
  machineApproveCommand,
  machineJoinCommand,
} from '../../../shared/credential-machine-trust.ts'
import { CpaceRefusal } from '../../../shared/cpace.ts'
import {
  decodeMachineJoinDone,
  decodeMachineJoinRecord,
  encodeMachineJoinDone,
  encodeMachineJoinRecord,
  MACHINE_JOIN_TAG_BYTES,
  type MachineJoinParty,
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
import {
  bytesEqual,
  type TrustLogKey,
  type TrustState,
  trustLogEntryHash,
} from '../../../shared/trust-log.ts'
import { verifiedTrustLogForSpace } from '../../../shared/trust-log-keys.ts'
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
type RegisteredKey = Awaited<ReturnType<ConfigClient['listMachineKeys']>>[number]

const now = (at: Ports['at']) => (typeof at === 'function' ? at() : (at ?? Date.now()))

const sideText = (side: Uint8Array) => Buffer.from(side).toString('hex')
const sideBytes = (side: string) => new Uint8Array(Buffer.from(side, 'hex'))
const concat = (...values: Uint8Array[]) =>
  new Uint8Array(Buffer.concat(values.map((value) => Buffer.from(value))))

export function registeredKeyAgrees(
  registered: RegisteredKey | undefined,
  key: TrustLogKey,
): boolean {
  return Boolean(
    registered &&
      registered.revokedAt === null &&
      registered.publicKey &&
      registered.signingPublicKey &&
      bytesEqual(new Uint8Array(Buffer.from(registered.publicKey, 'base64url')), key.publicKey) &&
      bytesEqual(registered.signingPublicKey, key.signingPublicKey),
  )
}

function wrapFailureRemedy(key: TrustLogKey, spaceSlug: string): string {
  const trust = credentialMachineTrustCommands({
    space: spaceSlug,
    keyId: key.keyId,
    publicKey: encoded(key.publicKey),
  }).trust
  return `\`${trust} --yes\``
}

export function unanchoredApprovalNotice(slug: string): string {
  return `space ${slug} is not anchored; run \`${PLATFORM_SLUG} machine anchor --space ${slug}\` from your own terminal`
}

function expirationRefusal(spaceSlug: string): Error {
  return new Error(`pairing code expired; start again with \`${machineJoinCommand(spaceSlug)}\``)
}

function relayRefusal(error: unknown, spaceSlug: string): never {
  if (error instanceof ConfigClientError && error.status === 410)
    throw new Error(
      `the pairing exchange failed or expired; start again with \`${machineJoinCommand(spaceSlug)}\` on the new machine`,
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
  spaceSlug: string,
): Promise<Map<string, RelayMessage>> {
  const found = new Map<string, RelayMessage>()
  while (found.size !== phases.length) {
    if (now(ports.at) >= new Date(expiresAt).getTime()) throw expirationRefusal(spaceSlug)
    let mailbox: Awaited<ReturnType<ConfigClient['readMachineJoinMessages']>>
    try {
      mailbox = await ports.client.readMachineJoinMessages(nameplate, side, destination)
    } catch (error) {
      relayRefusal(error, spaceSlug)
    }
    for (const message of mailbox.messages)
      if (phases.includes(message.phase) && !found.has(message.phase))
        found.set(message.phase, message)
    if (found.size !== phases.length)
      await pause(ports.pollMs ?? MACHINE_JOIN_POLL_MS, ports.signal)
  }
  return found
}

export async function localRecord(
  selected: SelectedSpace,
  ports: Ports,
): Promise<{
  own: TrustLogKey
  ownUserId: string
  signingPrivateKey: Uint8Array
  registered: RegisteredKey[]
}> {
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
  const listed = registered.find((machine) => machine.keyId === keyId)
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
  return {
    ownUserId: who.user.id,
    own,
    signingPrivateKey: signing.privateKey,
    registered,
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

const mismatch = (spaceSlug: string) =>
  new Error(`the pairing code did not match; start again with \`${machineJoinCommand(spaceSlug)}\``)

async function loadVerifiedTrustLog(ports: Ports, selected: SelectedSpace) {
  return verifiedTrustLogForSpace(ports.client, selected.spaceId, ports.env)
}

async function finishMachineJoinSession(
  party: MachineJoinParty,
  peer: RelayMessage,
  ports: Ports,
  selected: SelectedSpace,
  nameplate: string,
  ownSide: string,
): Promise<MachineJoinSession> {
  try {
    return party.finish(peer.body, sideBytes(peer.side))
  } catch (error) {
    if (error instanceof CpaceRefusal) {
      await burn(ports, selected, nameplate, ownSide)
      throw mismatch(selected.slug)
    }
    throw error
  }
}

function taggedSealedRecord(
  session: MachineJoinSession,
  role: 'joiner' | 'approver',
  spaceId: string,
  nameplate: string,
  phase: string,
  record: TrustLogKey,
): Uint8Array {
  return concat(
    makeMachineJoinTag(session, role),
    sealMachineJoinMessage(
      session,
      role,
      spaceId,
      nameplate,
      phase,
      encodeMachineJoinRecord(record),
    ),
  )
}

async function verifiedApprover(
  session: MachineJoinSession,
  confirmation: RelayMessage,
  selected: SelectedSpace,
  nameplate: string,
  ownSide: string,
  initial: TrustState | null,
  ports: Ports,
): Promise<TrustLogKey> {
  if (
    !verifyMachineJoinTag(session, 'approver', confirmation.body.slice(0, MACHINE_JOIN_TAG_BYTES))
  ) {
    await burn(ports, selected, nameplate, ownSide)
    throw mismatch(selected.slug)
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
    throw new Error(
      `the approving machine is not trusted by the space machine trust log; run \`${machineApproveCommand(selected.slug)}\` from a machine the trust log already trusts`,
    )
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
  ports: Ports,
): Promise<void> {
  const { head, wrapped } = decodeMachineJoinDone(
    openMachineJoinMessage(session, 'approver', selected.spaceId, nameplate, 'done', done.body),
  )
  if (head) {
    const { entries, state } = await loadVerifiedTrustLog(ports, selected)
    if (!state)
      throw new Error(
        "the record's machine trust log is empty although the approver named a trust-log head; do not trust this record, and report it",
      )
    const trustedOwn = state.keys.get(own.keyId)
    if (
      !trustedOwn ||
      !bytesEqual(trustedOwn.publicKey, own.publicKey) ||
      !bytesEqual(trustedOwn.signingPublicKey, own.signingPublicKey)
    )
      throw new Error(
        'the approved machine is absent from the verified machine trust log; do not trust this record, and report it',
      )
    if (!entries.some((entry) => bytesEqual(trustLogEntryHash(entry), head)))
      throw new Error(
        "the approver's trust-log head is not in the record's trust log; do not trust this record, and report it",
      )
  }
  await pinTrustedMachine(approver.keyId, approver.publicKey, approver.label, ports.env)
  if (!wrapped)
    throw new Error(
      `${approver.label} (${approver.keyId}) approved this machine but could not wrap the data key for it; on that machine run ${wrapFailureRemedy(own, selected.slug)}`,
    )
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
    throw mismatch(selected.slug)
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
    !registeredKeyAgrees(registered, joiner)
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
  initial: TrustState | null,
  ports: Ports,
): Promise<{ head: Uint8Array | null; failure: Error | null }> {
  const head = initial
    ? await appendSignedTrustLogEntry(
        ports.client,
        own.keyId,
        selected.spaceId,
        { kind: 'add', ...joiner },
        {
          action: `running ${PLATFORM_SLUG} machine approve`,
          retry: `\`${machineApproveCommand(selected.slug)}\``,
        },
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
      return {
        head,
        failure: new Error(
          `machine ${joiner.keyId} was approved but wrapping its data key failed; finish with ${wrapFailureRemedy(joiner, selected.slug)}`,
          { cause: error },
        ),
      }
    throw error
  }
  return { head, failure: null }
}

export async function machineJoin(
  selected: SelectedSpace,
  ports: Ports,
): Promise<{ label: string; keyId: string }> {
  const { own: record } = await localRecord(selected, ports)
  const destination = { destinationSpaceId: selected.spaceId }
  const { state: initial } = await loadVerifiedTrustLog(ports, selected)
  if (initial?.keys.has(record.keyId)) throw new Error('this machine is already approved')
  const allocated = await ports.client.allocateMachineJoinNameplate(destination)
  const code = generatePairingCode(allocated.nameplate)
  const formatted = formatPairingCode(code)
  ports.output?.(formatted)
  ports.output?.(
    `on an approved machine run: \`${machineApproveCommand(selected.slug, formatted)}\``,
  )
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
    selected.slug,
  )
  const pake = incoming.get('pake-b')!
  const confirmation = incoming.get('confirm-b')!
  const session = await finishMachineJoinSession(
    party,
    pake,
    ports,
    selected,
    allocated.nameplate,
    ownSide,
  )
  const approver = await verifiedApprover(
    session,
    confirmation,
    selected,
    allocated.nameplate,
    ownSide,
    initial,
    ports,
  )
  const confirmA = taggedSealedRecord(
    session,
    'joiner',
    selected.spaceId,
    allocated.nameplate,
    'confirm-a',
    record,
  )
  await ports.client.postMachineJoinMessage(
    allocated.nameplate,
    ownSide,
    'confirm-a',
    confirmA,
    destination,
  )
  const done = (
    await poll(
      ports,
      allocated.nameplate,
      ownSide,
      allocated.expiresAt,
      ['done'],
      destination,
      selected.slug,
    )
  ).get('done')!
  await acceptDone(done, session, selected, allocated.nameplate, approver, record, ports)
  return { label: approver.label, keyId: approver.keyId }
}

export async function machineApprove(
  codeText: string,
  selected: SelectedSpace,
  ports: Ports,
): Promise<{ label: string; keyId: string; anchored: boolean }> {
  const code: PairingCode = parsePairingCode(codeText)
  const { own: record } = await localRecord(selected, ports)
  const destination = { destinationSpaceId: selected.spaceId }
  const { state: initial } = await loadVerifiedTrustLog(ports, selected)
  if (initial && !initial.keys.has(record.keyId))
    throw new Error(
      `this machine is not trusted by the space machine trust log; have an owner approve it from an approved machine before retrying \`${machineApproveCommand(selected.slug)}\``,
    )
  const side = crypto.getRandomValues(new Uint8Array(16))
  const ownSide = sideText(side)
  let first: Awaited<ReturnType<ConfigClient['readMachineJoinMessages']>>
  try {
    first = await ports.client.readMachineJoinMessages(code.nameplate, ownSide, destination)
  } catch (error) {
    relayRefusal(error, selected.slug)
  }
  const pakeA =
    first.messages.find((message) => message.phase === 'pake-a') ??
    (
      await poll(
        ports,
        code.nameplate,
        ownSide,
        first.expiresAt,
        ['pake-a'],
        destination,
        selected.slug,
      )
    ).get(
      'pake-a',
    )!
  const party = startMachineJoin(code, selected.spaceId, first.expiresAt, 'approver', side)
  const session = await finishMachineJoinSession(
    party,
    pakeA,
    ports,
    selected,
    code.nameplate,
    ownSide,
  )
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
    taggedSealedRecord(session, 'approver', selected.spaceId, code.nameplate, 'confirm-b', record),
    destination,
  )
  const confirm = (
    await poll(
      ports,
      code.nameplate,
      ownSide,
      first.expiresAt,
      ['confirm-a'],
      destination,
      selected.slug,
    )
  ).get('confirm-a')!
  const joiner = await verifiedJoiner(confirm, session, selected, code.nameplate, ownSide, ports)
  const approved = await approveAndWrap(joiner, record, selected, initial, ports)
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
      encodeMachineJoinDone({ head: approved.head, wrapped: approved.failure === null }),
    ),
    destination,
  )
  if (approved.failure) throw approved.failure
  return { label: joiner.label, keyId: joiner.keyId, anchored: initial !== null }
}
