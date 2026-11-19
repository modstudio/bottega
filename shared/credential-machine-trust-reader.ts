import type { ConfigClient } from './config-client.ts'
import type { ConfigEnvironment } from './config-directory.ts'
import {
  type CredentialMachine,
  type CredentialMachineTrustFacts,
  credentialMachineTrustFacts,
} from './credential-machine-trust.ts'
import { parseRecordSpaceMemberships } from './record-space-membership.ts'
import { trustedKeysForSpace } from './trust-log-keys.ts'

export type CredentialMachineTrustSpace =
  | { kind: 'known'; spaceId: string; slug: string }
  | { kind: 'membership'; spaceId: string }

type TrustClient = Pick<ConfigClient, 'listMachineKeys' | 'readTrustLog' | 'whoami'>
type MachineSource = CredentialMachine | (() => CredentialMachine | Promise<CredentialMachine>)

const cause = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function spaceLabel(client: TrustClient, space: CredentialMachineTrustSpace) {
  if (space.kind === 'known') return space.slug
  const memberships = parseRecordSpaceMemberships((await client.whoami()).memberships)
  return memberships.find((membership) => membership.spaceId === space.spaceId)?.slug ?? space.spaceId
}

async function readFacts(
  client: TrustClient,
  input: { spaceId: string; label: string; machine: MachineSource },
  env: ConfigEnvironment,
): Promise<CredentialMachineTrustFacts> {
  const machine = typeof input.machine === 'function' ? await input.machine() : input.machine
  const [machineRows, trust] = await Promise.all([
    client.listMachineKeys({ destinationSpaceId: input.spaceId }),
    trustedKeysForSpace(client, input.spaceId, env),
  ])
  return credentialMachineTrustFacts({ space: input.label, machine, machineRows, trust })
}

/** Read and derive this machine's credential trust facts for one record space. */
export async function readCredentialMachineTrustFacts(
  client: TrustClient,
  input: { space: CredentialMachineTrustSpace; machine: MachineSource },
  env: ConfigEnvironment = process.env,
): Promise<CredentialMachineTrustFacts> {
  const label = await spaceLabel(client, input.space)
  return readFacts(
    client,
    { spaceId: input.space.spaceId, label, machine: input.machine },
    env,
  )
}

/** Preserve a useful, honest trust state when any failure-path read throws. */
export async function readCredentialMachineTrustFactsOrUnchecked(
  client: TrustClient,
  input: { space: CredentialMachineTrustSpace; machine: MachineSource },
  env: ConfigEnvironment = process.env,
): Promise<CredentialMachineTrustFacts> {
  let label = input.space.kind === 'known' ? input.space.slug : input.space.spaceId
  try {
    label = await spaceLabel(client, input.space)
    return await readFacts(
      client,
      { spaceId: input.space.spaceId, label, machine: input.machine },
      env,
    )
  } catch (error) {
    return { status: 'could-not-check', space: label, reason: cause(error) }
  }
}
