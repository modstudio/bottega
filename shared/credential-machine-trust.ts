import { PLATFORM_SLUG } from './brand.ts'

export type CredentialMachineTrustFacts = {
  registered: boolean
  trusted: boolean
  space: string
  keyId: string
  publicKey: string
}

export type CredentialMachine = { keyId: string; publicKey: Uint8Array }

/** Derive credential trust facts from one space's record rows and verified trust state. */
export function credentialMachineTrustFacts(input: {
  space: string
  machine: CredentialMachine
  machineRows: readonly { keyId: string; revokedAt: string | null }[]
  trust: Readonly<Record<string, unknown>>
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
  input: { space: string; machine: CredentialMachine },
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
