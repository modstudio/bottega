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

async function readFacts(
  client: TrustClient,
  input: { spaceId: string; label: string; machine: MachineSource; signedInUserId: string },
  env: ConfigEnvironment,
): Promise<CredentialMachineTrustFacts> {
  const machine = typeof input.machine === 'function' ? await input.machine() : input.machine
  const [machineRows, trust] = await Promise.all([
    client.listMachineKeys({ destinationSpaceId: input.spaceId }),
    trustedKeysForSpace(client, input.spaceId, env),
  ])
  return credentialMachineTrustFacts({
    space: input.label,
    signedInUserId: input.signedInUserId,
    machine,
    machineRows,
    trust,
  })
}

/** Preserve a useful, honest trust state when any failure-path read throws. */
export async function readCredentialMachineTrustFactsOrUnchecked(
  client: TrustClient,
  input: { space: CredentialMachineTrustSpace; machine: MachineSource },
  env: ConfigEnvironment = process.env,
): Promise<CredentialMachineTrustFacts> {
  let label = input.space.kind === 'known' ? input.space.slug : input.space.spaceId
  try {
    const current = await client.whoami()
    label =
      input.space.kind === 'known'
        ? input.space.slug
        : (parseRecordSpaceMemberships(current.memberships).find(
            (membership) => membership.spaceId === input.space.spaceId,
          )?.slug ?? input.space.spaceId)
    return await readFacts(
      client,
      {
        spaceId: input.space.spaceId,
        label,
        machine: input.machine,
        signedInUserId: current.user.id,
      },
      env,
    )
  } catch (error) {
    return { status: 'could-not-check', space: label, reason: cause(error) }
  }
}
