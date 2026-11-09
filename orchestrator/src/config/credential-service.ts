// concern: credential-service
/** Seals and addresses typed credentials without exposing plaintext to the hosted record. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  ConfigClientError,
  type ConfigDestination,
  type ConfigSecret,
  configClient,
} from '../../../shared/config-client.ts'
import {
  type CompleteCredentialFields,
  CREDENTIAL_ENVIRONMENTS,
  completeCredentialFields,
  credentialIdentityKey,
} from '../../../shared/credential.ts'
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
import {
  type CredentialEnvironment,
  type CredentialMode,
  type CredentialPayer,
  credentialHint,
  credentialPayerFromScope,
  credentialScopeFromPayer,
  credentialSetRefusalText,
  resolveCredential,
} from './credential.ts'
import { openHostedSecretRow } from './hosted-secret-row.ts'

export type CredentialAddress = {
  provider: string
  name: string | null
  type: string
  mode: CredentialMode
  environment: CredentialEnvironment
  payer: CredentialPayer
  projectId: string | null
  projectName?: string
  spaceName: string
  destinationSpaceId: string
}
export type ProjectCredentialTarget = Pick<Project, 'name' | 'recordId' | 'settings'>

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

/** Build the one canonical credential address used by project-bound consumers. */
export async function projectCredentialAddress(
  project: ProjectCredentialTarget,
  provider: string,
  client = configClient(),
): Promise<CredentialAddress> {
  if (!project.recordId) throw new Error(projectRecordIdentityRefusal(project.name))
  const who = await client.whoami()
  const destinationSpaceId = await requireProjectRecordDestination(project.name, project.settings, {
    whoami: async () => who,
  })
  const membership = recordSpaceMembership(
    destinationSpaceId,
    parseRecordSpaceMemberships(who.memberships),
  )
  if (!membership) throw new Error(recordSpaceMembershipRefusal(destinationSpaceId))
  return {
    provider,
    name: null,
    type: 'api-key',
    mode: 'default',
    environment: 'local',
    payer: 'personal',
    projectId: project.recordId,
    projectName: project.name,
    spaceName: membership.slug,
    destinationSpaceId,
  }
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
        },
        createDataKey: false,
        missingDestinationAccessRefusal: () => missingProjectWrapRefusal(address),
      },
    )
  } catch (error) {
    if (error instanceof ConfigClientError && error.status === 404)
      throw missingProjectWrapRefusal(address)
    throw error
  }
}

type CredentialRow = ConfigSecret & CompleteCredentialFields

export async function listCredentials(
  spaceId: string,
  filters: {
    mode?: CredentialMode
    environment?: CredentialEnvironment
    projectId?: string
  } = {},
  client = configClient(),
): Promise<CredentialRow[]> {
  const target = { destinationSpaceId: spaceId }
  const environments = filters.environment ? [filters.environment] : CREDENTIAL_ENVIRONMENTS
  const rows = await Promise.all(environments.map((env) => client.listSecrets(env, target)))
  return rows
    .flat()
    .flatMap((row) => {
      const fields = completeCredentialFields(row)
      return fields ? [{ ...row, ...fields }] : []
    })
    .filter(
      (row) =>
        (filters.mode === undefined || row.mode === filters.mode) &&
        (filters.projectId === undefined || row.projectId === filters.projectId),
    )
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
  if (!address.projectId || !address.projectName)
    throw new Error('credential value resolution requires a project binding')
  const projectId = address.projectId
  const projectName = address.projectName
  const rows = await listCredentials(address.destinationSpaceId, {}, client)
  const preferences = await client.listCredentialPreferences({
    destinationSpaceId: address.destinationSpaceId,
  })
  const result = resolveCredential({
    spaceId: address.destinationSpaceId,
    projectId,
    projectName,
    provider: address.provider,
    name: address.name,
    type: address.type,
    mode: address.mode,
    environment: address.environment,
    candidates: rows.map((row) => ({
      row,
      spaceId: address.destinationSpaceId,
      projectId: row.projectId ?? null,
      payer: credentialPayerFromScope(row.scope),
      provider: row.provider,
      name: row.name,
      type: row.type,
      mode: row.mode,
      environment: row.environment,
    })),
    preferences,
  })
  if (result.kind === 'refused') throw new Error(result.refusal)
  const { row } = result.credential
  return { ...result, row }
}

/** Resolve and open one project credential; plaintext exists only in the returned memory value. */
export async function resolveCredentialValue(address: CredentialAddress, client = configClient()) {
  const result = await resolveProjectCredential(address, client)
  const { row } = result
  const target = { destinationSpaceId: address.destinationSpaceId, projectId: row.projectId }
  const plaintext = await openHostedSecretRow(client, row, target)
  return { ...result, value: new TextDecoder('utf-8', { fatal: true }).decode(plaintext) }
}

/** Gather one metadata-only routing fact for each distinct provider. */
export async function projectCredentialRouteFacts(
  project: ProjectCredentialTarget | null,
  providers: Iterable<string>,
  client = configClient(),
) {
  const entries = await Promise.all(
    [...new Set(providers)].map(async (provider) => {
      try {
        if (!project) throw new Error(providerProjectRequiredRefusal())
        const address = await projectCredentialAddress(project, provider, client)
        await resolveProjectCredential(address, client)
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
