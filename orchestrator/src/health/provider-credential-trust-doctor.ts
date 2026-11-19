// concern: doctor
import { AGENTS } from '../agent/agent-registry.ts'
import { projects } from '../project/projects.ts'
import { reportProviderCredentialTrustDoctor as reportTrust } from '../setup/provider-credential-trust.ts'

export async function reportProviderCredentialTrustDoctor(log: (line: string) => void) {
  await reportTrust(log, Object.values(AGENTS), projects())
}
