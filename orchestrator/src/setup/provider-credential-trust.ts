// concern: provider-credential-trust setup facts
/** Gathers bounded hosted facts for the credential spaces provider-backed agents use. */

import { configClient } from '../../../shared/config-client.ts'
import { machineKeyInfo, readMachineKey } from '../../../shared/machine-key-store.ts'
import { readRecordSessionToken } from '../../../shared/record-session.ts'
import {
  parseRecordSpaceMemberships,
  recordSpaceMembership,
} from '../../../shared/record-space-membership.ts'
import { trustedKeysForSpace } from '../../../shared/trust-log-keys.ts'
import type { Project } from '../project/projects.ts'
import {
  providerCredentialTrustNotices,
  type SetupCredentialTrustFact,
} from './provider-credential-trust-notice.ts'
import type { SetupAgent } from './setup-engine.ts'
import { SETUP_COMMAND_TIMEOUT_MS } from './setup-mcp.ts'

const cause = (error: unknown) => (error instanceof Error ? error.message : String(error))

const boundedClient = () =>
  configClient(process.env, fetch, undefined, AbortSignal.timeout(SETUP_COMMAND_TIMEOUT_MS))

/** Read each distinct provider credential space once; unsigned-in machines have no hosted fact. */
export async function gatherProviderCredentialTrustFacts(
  agents: readonly SetupAgent[],
  projects: readonly Project[],
): Promise<SetupCredentialTrustFact[]> {
  if (!agents.some((agent) => agent.enabled && agent.provider?.trim())) return []
  if (!readRecordSessionToken()) return []
  const declared = [
    ...new Set(projects.map((project) => project.settings.space?.trim()).filter(Boolean)),
  ] as string[]
  if (!declared.length) return []
  const pair = readMachineKey()
  if (!pair)
    return declared.map((space) => ({
      status: 'could-not-check',
      space,
      reason: 'machine key is not initialized',
    }))
  const machine = await machineKeyInfo(pair)
  let memberships: ReturnType<typeof parseRecordSpaceMemberships>
  try {
    memberships = parseRecordSpaceMemberships((await boundedClient().whoami()).memberships)
  } catch (error) {
    return declared.map((space) => ({ status: 'could-not-check', space, reason: cause(error) }))
  }
  return Promise.all(
    declared.map(async (declaredSpace): Promise<SetupCredentialTrustFact> => {
      const membership = recordSpaceMembership(declaredSpace, memberships)
      if (!membership)
        return {
          status: 'could-not-check',
          space: declaredSpace,
          reason: 'the signed-in user is not a member of that space',
        }
      try {
        const [registered, trust] = await Promise.all([
          boundedClient().listMachineKeys({ destinationSpaceId: membership.spaceId }),
          trustedKeysForSpace(boundedClient(), membership.spaceId),
        ])
        return {
          status: 'checked',
          space: membership.slug,
          keyId: machine.keyId,
          publicKey: Buffer.from(machine.publicKey).toString('base64url'),
          registered: registered.some(
            (row) => row.keyId === machine.keyId && row.revokedAt === null,
          ),
          trusted: trust[machine.keyId] !== undefined,
        }
      } catch (error) {
        return { status: 'could-not-check', space: membership.slug, reason: cause(error) }
      }
    }),
  )
}

export async function reportProviderCredentialTrustDoctor(
  log: (line: string) => void,
  agents: readonly SetupAgent[],
  projects: readonly Project[],
): Promise<void> {
  const notices = providerCredentialTrustNotices(
    await gatherProviderCredentialTrustFacts(agents, projects),
  )
  if (!notices.length) return
  log('provider credential trust')
  for (const notice of notices) log(`  ${notice.message}; ${notice.fix}`)
}
