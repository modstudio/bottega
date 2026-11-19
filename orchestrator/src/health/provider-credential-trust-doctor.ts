// concern: doctor
import { AGENTS } from '../agent/agent-registry.ts'
import { projects } from '../project/projects.ts'
import { gatherProviderCredentialTrustFacts } from '../setup/provider-credential-trust.ts'
import { providerCredentialTrustNotices } from '../setup/provider-credential-trust-notice.ts'

export async function reportProviderCredentialTrustDoctor(log: (line: string) => void) {
  const notices = providerCredentialTrustNotices(
    await gatherProviderCredentialTrustFacts(Object.values(AGENTS), projects()),
  )
  if (!notices.length) return
  log('provider credential trust')
  for (const notice of notices) log(`  ${notice.message}; ${notice.fix}`)
}
