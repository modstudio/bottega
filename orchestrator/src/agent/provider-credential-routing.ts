// concern: provider credential routing adapter
/** Gathers project and credential metadata once before a routing pass. */

import { projectCredentialRouteFacts } from '../config/credential-service.ts'
import { projectAt, type Project } from '../project/projects.ts'
import { AGENTS } from './agent-registry.ts'

export async function providerCredentialRouting(project: Project | null) {
  const facts = await projectCredentialRouteFacts(
    project,
    Object.values(AGENTS).flatMap((agent) => (agent.provider ? [agent.provider] : [])),
  )
  return { project, facts }
}

export async function providerCredentialRoutingAt(cwd: string) {
  return providerCredentialRouting(projectAt(cwd))
}
