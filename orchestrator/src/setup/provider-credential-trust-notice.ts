// concern: provider credential trust setup notice
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  type CredentialMachineTrustFacts,
  credentialMachineTrustRemedy,
} from '../../../shared/credential-machine-trust.ts'

type ProviderCredentialTrustNotice = { message: string; fix: string; blocking: false }

export type SetupCredentialTrustFact =
  | ({ status: 'checked' } & CredentialMachineTrustFacts)
  | { status: 'could-not-check'; space: string; reason: string }

export function providerCredentialTrustNotices(
  facts: readonly SetupCredentialTrustFact[],
): ProviderCredentialTrustNotice[] {
  return facts.flatMap((fact) => {
    if (fact.status === 'could-not-check')
      return [
        {
          message: `provider credential trust was not checked in record space ${fact.space}: ${fact.reason}`,
          fix: `${PLATFORM_SLUG} machine setup plan`,
          blocking: false,
        },
      ]
    const fix = credentialMachineTrustRemedy(fact)
    return fix
      ? [
          {
            message: `provider credentials in record space ${fact.space} cannot be opened because this machine is not trusted there`,
            fix,
            blocking: false,
          },
        ]
      : []
  })
}
