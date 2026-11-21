// concern: provider-credential-trust setup facts
/** Gathers bounded hosted facts for the credential spaces provider-backed agents use. */

import { hostedApiFetch } from '../../../shared/bounded-fetch.ts'
import { configClient } from '../../../shared/config-client.ts'
import type {
  CredentialMachine,
  CredentialMachineTrustFacts,
} from '../../../shared/credential-machine-trust.ts'
import { readCredentialMachineTrustFactsOrUnchecked } from '../../../shared/credential-machine-trust-reader.ts'
import { machineKeyInfo, readMachineKey } from '../../../shared/machine-key-store.ts'
import { readRecordSessionToken } from '../../../shared/record-session.ts'
import {
  parseRecordSpaceMemberships,
  recordSpaceMembership,
} from '../../../shared/record-space-membership.ts'
import type { Project } from '../project/projects.ts'
import { SETUP_COMMAND_TIMEOUT_MS } from './setup-mcp.ts'

type ProviderAgent = { enabled?: number | boolean; provider?: string | null }

export type GatherProviderCredentialTrustDependencies = {
  sessionToken: () => string | null | Promise<string | null>
  machine: () => CredentialMachine | null | Promise<CredentialMachine | null>
  client: () => ReturnType<typeof configClient>
}

const cause = (error: unknown) => (error instanceof Error ? error.message : String(error))
const unchecked = (spaces: readonly string[], reason: string): CredentialMachineTrustFacts[] =>
  spaces.map((space) => ({ status: 'could-not-check', space, reason }))

const dependencies: GatherProviderCredentialTrustDependencies = {
  sessionToken: readRecordSessionToken,
  machine: async () => {
    const pair = readMachineKey()
    return pair ? machineKeyInfo(pair) : null
  },
  client: () =>
    configClient(
      process.env,
      hostedApiFetch,
      undefined,
      AbortSignal.timeout(SETUP_COMMAND_TIMEOUT_MS),
    ),
}

/** Read each distinct provider credential space once; unsigned-in machines have no hosted fact. */
export async function gatherProviderCredentialTrustFacts(
  agents: readonly ProviderAgent[],
  projects: readonly Project[],
  deps: GatherProviderCredentialTrustDependencies = dependencies,
): Promise<CredentialMachineTrustFacts[]> {
  if (
    !agents.some(
      (agent) => agent.enabled !== false && agent.enabled !== 0 && agent.provider?.trim(),
    )
  )
    return []
  const declared = [
    ...new Set(projects.map((project) => project.settings.space?.trim()).filter(Boolean)),
  ] as string[]
  if (!declared.length) return []

  let token: string | null
  try {
    token = await deps.sessionToken()
  } catch (error) {
    return unchecked(declared, cause(error))
  }
  if (!token) return []

  let machine: CredentialMachine | null
  try {
    machine = await deps.machine()
  } catch (error) {
    return unchecked(declared, cause(error))
  }
  if (!machine) return unchecked(declared, 'machine key is not initialized')

  let client: ReturnType<typeof configClient>
  let memberships: ReturnType<typeof parseRecordSpaceMemberships>
  try {
    client = deps.client()
    memberships = parseRecordSpaceMemberships((await client.whoami()).memberships)
  } catch (error) {
    return unchecked(declared, cause(error))
  }

  return Promise.all(
    declared.map(async (declaredSpace): Promise<CredentialMachineTrustFacts> => {
      const membership = recordSpaceMembership(declaredSpace, memberships)
      if (!membership)
        return {
          status: 'could-not-check',
          space: declaredSpace,
          reason: 'the signed-in user is not a member of that space',
        }
      return readCredentialMachineTrustFactsOrUnchecked(client, {
        space: { kind: 'known', spaceId: membership.spaceId, slug: membership.slug },
        machine,
      })
    }),
  )
}
