import { PLATFORM_SLUG } from './brand.ts'

export type CredentialMachineTrustFacts = {
  registered: boolean
  trusted: boolean
  space: string
  keyId: string
  publicKey: string
}

/** Order the complete repair for a machine that cannot open credentials in one space. */
export function credentialMachineTrustSteps(facts: CredentialMachineTrustFacts): string[] {
  if (facts.trusted) return []
  const spaceOption = ` --space ${facts.space}`
  return [
    ...(facts.registered
      ? []
      : [`${PLATFORM_SLUG} machine config machine register${spaceOption}`]),
    `${PLATFORM_SLUG} machine config machine trust ${facts.keyId} ${facts.publicKey}${spaceOption}`,
  ]
}

export function credentialMachineTrustRemedy(facts: CredentialMachineTrustFacts): string | null {
  const steps = credentialMachineTrustSteps(facts)
  if (!steps.length) return null
  const trust = `from a machine already trusted in that space, run \`${steps.at(-1)}\``
  return steps.length === 1
    ? trust
    : `on this machine, run \`${steps[0]}\`; then ${trust}`
}
