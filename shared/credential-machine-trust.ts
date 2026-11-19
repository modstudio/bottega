import { PLATFORM_SLUG } from './brand.ts'
import type { ConfigClient, MachineKey } from './config-client.ts'
import type { ConfigEnvironment } from './config-directory.ts'
import { type TrustedKeys, trustedKeysForSpace } from './trust-log-keys.ts'

export type CredentialMachineTrustFacts = {
  registered: boolean
  trusted: boolean
  space: string
  keyId: string
  publicKey: string
}

type LocalMachine = { keyId: string; publicKey: Uint8Array }

/** Derive credential trust facts from one space's record rows and verified trust state. */
export function credentialMachineTrustFacts(input: {
  space: string
  machine: LocalMachine
  machineRows: readonly Pick<MachineKey, 'keyId' | 'revokedAt'>[]
  trust: TrustedKeys
}): CredentialMachineTrustFacts {
  return {
    registered: input.machineRows.some(
      (row) => row.keyId === input.machine.keyId && row.revokedAt === null,
    ),
    trusted: input.trust[input.machine.keyId] !== undefined,
    space: input.space,
    keyId: input.machine.keyId,
    publicKey: Buffer.from(input.machine.publicKey).toString('base64url'),
  }
}

/** Read and derive this machine's credential trust facts for one record space. */
export async function readCredentialMachineTrustFacts(
  client: Pick<ConfigClient, 'listMachineKeys' | 'readTrustLog'>,
  input: { spaceId: string; space: string; machine: LocalMachine },
  env: ConfigEnvironment = process.env,
): Promise<CredentialMachineTrustFacts> {
  const [machineRows, trust] = await Promise.all([
    client.listMachineKeys({ destinationSpaceId: input.spaceId }),
    trustedKeysForSpace(client, input.spaceId, env),
  ])
  return credentialMachineTrustFacts({
    space: input.space,
    machine: input.machine,
    machineRows,
    trust,
  })
}

/** Order the complete repair for a machine that cannot open credentials in one space. */
export function credentialMachineTrustSteps(facts: CredentialMachineTrustFacts): string[] {
  if (facts.trusted) return []
  const spaceOption = ` --space ${facts.space}`
  return [
    ...(facts.registered ? [] : [`${PLATFORM_SLUG} machine config machine register${spaceOption}`]),
    `${PLATFORM_SLUG} machine config machine trust ${facts.keyId} ${facts.publicKey}${spaceOption}`,
  ]
}

export function credentialMachineTrustRemedy(facts: CredentialMachineTrustFacts): string | null {
  const steps = credentialMachineTrustSteps(facts)
  if (!steps.length) return null
  const trust = `from a machine already trusted in that space, run \`${steps.at(-1)}\``
  return steps.length === 1 ? trust : `on this machine, run \`${steps[0]}\`; then ${trust}`
}

export function noDataKeyWrapRemedy(input: {
  space: string
  keyId: string
  publicKey: string
}): string {
  return `this machine has no data-key wrap in record space ${input.space}; from a machine that already opens that space, run \`${PLATFORM_SLUG} machine config machine trust ${input.keyId} ${input.publicKey} --space ${input.space}\``
}

/** Render the actual missing-wrap condition from facts gathered after the failure. */
export function missingDataKeyWrapRemedy(facts: CredentialMachineTrustFacts): string {
  const trustRemedy = credentialMachineTrustRemedy(facts)
  return trustRemedy
    ? `this machine is not trusted in record space ${facts.space}; ${trustRemedy}`
    : noDataKeyWrapRemedy(facts)
}

export function uncheckedCredentialMachineTrustRemedy(
  input: { space: string; machine: LocalMachine },
  reason: string,
): string {
  const facts = credentialMachineTrustFacts({
    space: input.space,
    machine: input.machine,
    machineRows: [],
    trust: {},
  })
  const remedy = credentialMachineTrustRemedy(facts)
  return `credential trust could not be checked in record space ${input.space}: ${reason}; ${remedy}`
}
