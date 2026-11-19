// concern: provider credential trust setup notice
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  type CredentialMachineTrustFacts,
  credentialMachineTrustRemedy,
} from '../../../shared/credential-machine-trust.ts'

type ProviderCredentialTrustNotice = { message: string; fix: string; blocking: false }

export type SetupCredentialTrustFact = CredentialMachineTrustFacts

export function providerCredentialTrustNotices(
  facts: readonly SetupCredentialTrustFact[],
): ProviderCredentialTrustNotice[] {
  return facts.flatMap((fact) => {
    const remedy = credentialMachineTrustRemedy(fact)
    if (!remedy) return []
    if (fact.status === 'could-not-check')
      return [
        {
          message: remedy,
          fix: `${PLATFORM_SLUG} machine setup plan`,
          blocking: false,
        },
      ]
    return [
      {
        message: `provider credentials in record space ${fact.space} cannot be opened because this machine is not trusted there`,
        fix: remedy,
        blocking: false,
      },
    ]
  })
}
