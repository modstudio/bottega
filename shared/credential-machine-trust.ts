import { PLATFORM_SLUG } from './brand.ts'

export type CheckedCredentialMachineTrustFacts = {
  status: 'checked'
  registered: boolean
  revoked: boolean
  trusted: boolean
  space: string
  keyId: string
  publicKey: string
}

export type CredentialMachineTrustFacts =
  | CheckedCredentialMachineTrustFacts
  | CouldNotCheckCredentialMachineTrustFacts

export type CouldNotCheckCredentialMachineTrustFacts = {
  status: 'could-not-check'
  space: string
  reason: string
}

export type CredentialMachine = { keyId: string; publicKey: Uint8Array }

/** Keep every machine credential-trust command spelling in one place. */
export function credentialMachineTrustCommands(input: {
  space: string
  keyId?: string
  publicKey?: string
}) {
  const spaceOption = ` --space ${input.space}`
  return {
    init: `${PLATFORM_SLUG} machine config machine init${spaceOption}`,
    register: `${PLATFORM_SLUG} machine config machine register${spaceOption}`,
    trust: `${PLATFORM_SLUG} machine config machine trust ${input.keyId ?? '<keyId>'} ${input.publicKey ?? '<publicKey>'}${spaceOption}`,
  }
}

/** Derive credential trust facts from one space's record rows and verified trust state. */
export function credentialMachineTrustFacts(input: {
  space: string
  machine: CredentialMachine
  machineRows: readonly { keyId: string; revokedAt: string | null }[]
  trust: Readonly<Record<string, unknown>>
}): CheckedCredentialMachineTrustFacts {
  const registration = input.machineRows.find((row) => row.keyId === input.machine.keyId)
  return {
    status: 'checked',
    registered: registration !== undefined && registration.revokedAt === null,
    revoked: registration?.revokedAt != null,
    trusted: input.trust[input.machine.keyId] !== undefined,
    space: input.space,
    keyId: input.machine.keyId,
    publicKey: Buffer.from(input.machine.publicKey).toString('base64url'),
  }
}

/** Order the complete repair for a machine that cannot open credentials in one space. */
export function credentialMachineTrustSteps(facts: CheckedCredentialMachineTrustFacts): string[] {
  const commands = credentialMachineTrustCommands(facts)
  if (facts.revoked) return [commands.init, commands.register, commands.trust]
  if (facts.trusted) return []
  return [...(facts.registered ? [] : [commands.register]), commands.trust]
}

/** Render the trust state, including an honest conditional repair when it could not be checked. */
export function credentialMachineTrustRemedy(
  facts: CouldNotCheckCredentialMachineTrustFacts,
): string
export function credentialMachineTrustRemedy(facts: CredentialMachineTrustFacts): string | null
export function credentialMachineTrustRemedy(facts: CredentialMachineTrustFacts): string | null {
  if (facts.status === 'could-not-check') {
    const commands = credentialMachineTrustCommands({ space: facts.space })
    return `credential trust could not be checked in record space ${facts.space}: ${facts.reason}; if this machine is not registered there, on this machine run \`${commands.register}\`; then from a machine already trusted in that space, run \`${commands.trust}\``
  }
  const steps = credentialMachineTrustSteps(facts)
  if (!steps.length) return null
  if (facts.revoked)
    return `on this machine, run \`${steps[0]}\` to make a new key, then \`${steps[1]}\`; then from a machine already trusted in that space, run \`${steps[2]}\``
  const trust = `from a machine already trusted in that space, run \`${steps.at(-1)}\``
  return steps.length === 1 ? trust : `on this machine, run \`${steps[0]}\`; then ${trust}`
}

export function noDataKeyWrapRemedy(input: {
  space: string
  keyId: string
  publicKey: string
}): string {
  const command = credentialMachineTrustCommands(input).trust
  return `this machine has no data-key wrap in record space ${input.space}; from a machine that already opens that space, run \`${command}\``
}

/** Render the actual missing-wrap condition from facts gathered after the failure. */
export function missingDataKeyWrapRemedy(facts: CredentialMachineTrustFacts): string {
  const trustRemedy = credentialMachineTrustRemedy(facts)
  if (facts.status === 'could-not-check') return credentialMachineTrustRemedy(facts)
  return trustRemedy
    ? `this machine is not trusted in record space ${facts.space}; ${trustRemedy}`
    : noDataKeyWrapRemedy(facts)
}
