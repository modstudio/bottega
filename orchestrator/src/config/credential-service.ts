// concern: credential-service
/** Seals and addresses typed credentials without exposing plaintext to the hosted record. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  ConfigClientError,
  type ConfigDestination,
  configClient,
} from '../../../shared/config-client.ts'
import {
  CREDENTIAL_ENVIRONMENTS,
  type CredentialEnvironment,
  type CredentialMode,
  type CredentialPayer,
  credentialIdentityKey,
} from '../../../shared/credential.ts'
import {
  credentialScopeFromPayer,
  credentialSetRefusalText,
} from '../../../shared/credential-resolution.ts'
import {
  type CredentialResolutionAddress,
  listCredentials as listHostedCredentials,
  openHostedCredentialRowValue,
  resolveHostedCredential,
  resolveHostedCredentialValue,
} from '../../../shared/credential-value.ts'
import type { OperatorCredentialIdentity } from '../../../shared/operator-credentials.ts'
import {
  configAccessRemedy,
  machineNotTrustedRemedy,
  recordSpaceMembershipRefusal,
} from '../../../shared/record-remedies.ts'
import {
  parseRecordSpaceMemberships,
  recordSpaceMembership,
} from '../../../shared/record-space-membership.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { sealedValueIsEmpty, stripTrailingNewline } from '../../../shared/sealed-value.ts'
import type { Project } from '../project/projects.ts'
import { requireProjectRecordDestination } from '../record/record-project-destination-client.ts'
import { deleteSecret, setSecret } from './config-service.ts'
import { credentialHint } from './credential-presentation.ts'

export type CredentialAddress = CredentialResolutionAddress & {
  payer: CredentialPayer
  account?: boolean
  reachSpaceIds?: string[] | null
}
export type ProjectCredentialTarget = Pick<Project, 'name' | 'settings'> & {
  recordId: string | null
}
export type ProjectCredentialBinding = Pick<
  CredentialAddress,
  'projectId' | 'projectName' | 'spaceName' | 'destinationSpaceId'
>

export function projectRecordIdentityRefusal(project: string): string {
  return renderRefusal(
    refusal(`project ${project} has no hosted record identity`, {
      kind: 'command',
      argv: [PLATFORM_SLUG, 'project', 'push'],
    }),
  )
}

export function providerProjectRequiredRefusal(): string {
  return renderRefusal(
    refusal('provider-backed agent requires a registered project', {
      kind: 'edit',
      text: 'run the command from a registered project',
    }),
  )
}

/** Resolve the project and record-space identity shared by every project-bound command. */
export async function projectCredentialBinding(
  project: ProjectCredentialTarget,
  client?: ReturnType<typeof configClient>,
): Promise<ProjectCredentialBinding> {
  if (!project.recordId) throw new Error(projectRecordIdentityRefusal(project.name))
  const selectedClient = client ?? configClient()
  const who = await selectedClient.whoami()
  const destinationSpaceId = await requireProjectRecordDestination(project.name, project.settings, {
    whoami: async () => who,
  })
  const membership = recordSpaceMembership(
    destinationSpaceId,
    parseRecordSpaceMemberships(who.memberships),
  )
  if (!membership) throw new Error(recordSpaceMembershipRefusal(destinationSpaceId))
  return {
    projectId: project.recordId,
    projectName: project.name,
    spaceName: membership.slug,
    destinationSpaceId,
  }
}

export async function accountCredentialBinding(
  client = configClient(),
): Promise<ProjectCredentialBinding> {
  const who = await client.whoami()
  if (!who.personalSpaceId) throw new Error('personal space is not provisioned')
  const membership = recordSpaceMembership(
    who.personalSpaceId,
    parseRecordSpaceMemberships(who.memberships),
  )
  if (!membership) throw new Error(recordSpaceMembershipRefusal(who.personalSpaceId))
  return {
    projectId: null,
    projectName: undefined,
    spaceName: membership.slug,
    destinationSpaceId: who.personalSpaceId,
  }
}

/** Build the one canonical credential address used by project-bound consumers. */
export async function projectCredentialAddress(
  project: ProjectCredentialTarget,
  provider: string,
  client?: ReturnType<typeof configClient>,
): Promise<CredentialAddress> {
  return {
    provider,
    name: null,
    type: 'api-key',
    mode: 'default',
    environment: 'local',
    payer: 'personal',
    ...(await projectCredentialBinding(project, client)),
  }
}

/** Apply an operator identity while retaining every project credential binding and default. */
export function operatorProjectCredentialAddress(
  address: CredentialAddress,
  identity: OperatorCredentialIdentity,
): CredentialAddress {
  return { ...address, ...identity }
}

const destination = (address: CredentialAddress): ConfigDestination => ({
  destinationSpaceId: address.destinationSpaceId,
  projectId: address.projectId,
})
function missingProjectWrapRefusal(address: CredentialAddress): Error {
  const binding = address.projectName
    ? `project ${address.projectName} in space ${address.spaceName}`
    : `space ${address.spaceName}`
  return new Error(
    `cannot access credentials for ${binding}: ${machineNotTrustedRemedy(address.spaceName)}; ${configAccessRemedy(address.spaceName)}`,
  )
}

function missingAccountWrapRefusal(address: CredentialAddress): Error {
  return new Error(
    `cannot access account credentials: run \`${PLATFORM_SLUG} machine config machine register --space ${address.spaceName}\``,
  )
}

const missingWrapRefusal = (address: CredentialAddress) =>
  address.account ? missingAccountWrapRefusal(address) : missingProjectWrapRefusal(address)

function missingCredentialRefusal(address: CredentialAddress): Error {
  return new Error(credentialSetRefusalText(address, 'missing', 'pipe its value to'))
}

function blankCredentialRefusal(address: CredentialAddress): Error {
  return new Error(credentialSetRefusalText(address, 'blank', 'pipe a non-blank value to'))
}

export async function setCredential(
  address: CredentialAddress,
  value: string,
  client = configClient(),
  expectedRowVersion?: number,
) {
  if (sealedValueIsEmpty(value)) throw blankCredentialRefusal(address)
  const plaintext = stripTrailingNewline(value)
  try {
    return await setSecret(
      credentialIdentityKey(address),
      plaintext,
      credentialScopeFromPayer(address.payer),
      client,
      {
        destination: destination(address),
        environment: address.environment,
        metadata: {
          projectId: address.projectId,
          provider: address.provider,
          name: address.name,
          type: address.type,
          hint: credentialHint(plaintext),
          mode: address.mode,
          ...(address.account && address.reachSpaceIds !== undefined
            ? { reachSpaceIds: address.reachSpaceIds }
            : {}),
        },
        createDataKey: false,
        expectedRowVersion,
        missingDestinationAccessRefusal: () => missingWrapRefusal(address),
      },
    )
  } catch (error) {
    if (error instanceof ConfigClientError && error.status === 404)
      throw missingWrapRefusal(address)
    throw error
  }
}

export async function reachCredential(
  address: CredentialAddress,
  reachSpaceIds: string[] | null,
  client = configClient(),
) {
  if (!address.account) throw new Error('credential reach requires --account')
  const key = credentialIdentityKey(address)
  const row = (
    await listHostedCredentials(address.destinationSpaceId, client, [address.environment])
  ).find(
    (candidate) =>
      candidate.key === key && candidate.scope === 'user' && candidate.projectId == null,
  )
  if (!row) throw missingCredentialRefusal(address)
  const value = await openHostedCredentialRowValue(row, address.destinationSpaceId, client)
  return setCredential({ ...address, reachSpaceIds }, value, client, row.rowVersion)
}

export async function listCredentials(
  spaceId: string,
  filters: {
    mode?: CredentialMode
    environment?: CredentialEnvironment
    projectId?: string
    account?: boolean
  } = {},
  client = configClient(),
) {
  const environments = filters.environment ? [filters.environment] : CREDENTIAL_ENVIRONMENTS
  return (await listHostedCredentials(spaceId, client, environments)).filter(
    (row) =>
      (filters.mode === undefined || row.mode === filters.mode) &&
      (filters.projectId === undefined || row.projectId === filters.projectId) &&
      (!filters.account || (row.scope === 'user' && row.projectId == null)),
  )
}

function requireProjectCredentialAddress(
  address: CredentialAddress,
): asserts address is CredentialAddress & { projectId: string; projectName: string } {
  if (!address.projectId || !address.projectName)
    throw new Error('credential value resolution requires a project binding')
}

export async function deleteCredential(address: CredentialAddress, client = configClient()) {
  const key = credentialIdentityKey(address)
  try {
    return await deleteSecret(key, credentialScopeFromPayer(address.payer), client, {
      destination: destination(address),
      environment: address.environment,
    })
  } catch (error) {
    if (error instanceof ConfigClientError && error.status === 404)
      throw missingCredentialRefusal(address)
    throw error
  }
}

/** Resolve one project credential and retain the selected hosted row without matching it again. */
export async function resolveProjectCredential(
  address: CredentialAddress,
  client = configClient(),
) {
  requireProjectCredentialAddress(address)
  const result = await resolveHostedCredential(address, client)
  if (result.kind === 'refused') throw new Error(result.refusal)
  return result
}

/** Resolve and open one project credential; plaintext exists only in the returned memory value. */
export async function resolveCredentialValue(address: CredentialAddress, client = configClient()) {
  requireProjectCredentialAddress(address)
  const result = await resolveHostedCredentialValue(address, client)
  if (result.kind === 'refused') throw new Error(result.refusal)
  return result
}

/** Resolve and open one project-bound operator credential; `refused` is the missing case. */
export async function resolveProjectOperatorCredential(
  project: ProjectCredentialTarget,
  identity: OperatorCredentialIdentity,
  client = configClient(),
): Promise<string | undefined> {
  const address = operatorProjectCredentialAddress(
    await projectCredentialAddress(project, identity.provider, client),
    identity,
  )
  requireProjectCredentialAddress(address)
  const result = await resolveHostedCredentialValue(address, client)
  return result.kind === 'refused' ? undefined : result.value
}

/** Observe whether metadata contains a default local credential usable by one project. */
export async function projectHasCredential(
  project: ProjectCredentialTarget,
  identity: OperatorCredentialIdentity,
  client = configClient(),
): Promise<boolean> {
  const address = operatorProjectCredentialAddress(
    await projectCredentialAddress(project, identity.provider, client),
    identity,
  )
  return (await resolveHostedCredential(address, client)).kind === 'resolved'
}

/** Gather one metadata-only routing fact for each distinct provider. */
export async function projectCredentialRouteFacts(
  project: ProjectCredentialTarget | null,
  providers: Iterable<string>,
  client?: ReturnType<typeof configClient>,
) {
  const distinctProviders = [...new Set(providers)]
  if (!distinctProviders.length) return new Map()
  const selectedClient = client ?? configClient()
  const entries = await Promise.all(
    distinctProviders.map(async (provider) => {
      try {
        if (!project) throw new Error(providerProjectRequiredRefusal())
        const address = await projectCredentialAddress(project, provider, selectedClient)
        await resolveProjectCredential(address, selectedClient)
        return [provider, { status: 'resolved' as const }] as const
      } catch (error) {
        return [
          provider,
          error instanceof ConfigClientError
            ? { status: 'unknown' as const }
            : { status: 'refused' as const, refusal: String((error as Error)?.message ?? error) },
        ] as const
      }
    }),
  )
  return new Map<string, (typeof entries)[number][1]>(entries)
}
