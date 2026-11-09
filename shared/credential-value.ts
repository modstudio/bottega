// concern: credential-value
/** Resolves and opens one typed credential without exposing plaintext to the hosted record. */

import { type ConfigClient, type ConfigSecret, configClient } from './config-client.ts'
import {
  type CompleteCredentialFields,
  CREDENTIAL_ENVIRONMENTS,
  type CredentialEnvironment,
  type CredentialMode,
  completeCredentialFields,
} from './credential.ts'
import { credentialPayerFromScope, resolveCredential } from './credential-resolution.ts'
import { openHostedSecretRow } from './hosted-secret-row.ts'
import { RECORD_ACTIVE_SPACE_REMEDY, recordSpaceMembershipRefusal } from './record-remedies.ts'
import { parseRecordSpaceMemberships, recordSpaceMembership } from './record-space-membership.ts'

export type CredentialResolutionAddress = {
  provider: string
  name: string | null
  type: string
  mode: CredentialMode
  environment: CredentialEnvironment
  projectId: string | null
  projectName?: string
  spaceName: string
  destinationSpaceId: string
}

export type CredentialRow = ConfigSecret & CompleteCredentialFields

export async function listCredentials(
  spaceId: string,
  client: ConfigClient,
  environments: readonly CredentialEnvironment[] = CREDENTIAL_ENVIRONMENTS,
): Promise<CredentialRow[]> {
  const destination = { destinationSpaceId: spaceId }
  const rows = await Promise.all(
    environments.map((environment) => client.listSecrets(environment, destination)),
  )
  return rows.flat().flatMap((row) => {
    const fields = completeCredentialFields(row)
    return fields ? [{ ...row, ...fields }] : []
  })
}

export async function resolveHostedCredential(
  address: CredentialResolutionAddress,
  client: ConfigClient = configClient(),
) {
  const who = await client.whoami()
  const destinationRows = await listCredentials(address.destinationSpaceId, client)
  const personalSpaceId = who.personalSpaceId ?? null
  const accountRows =
    personalSpaceId === null
      ? []
      : personalSpaceId === address.destinationSpaceId
        ? destinationRows
        : await listCredentials(personalSpaceId, client)
  const destinationCandidates =
    personalSpaceId === address.destinationSpaceId
      ? destinationRows.filter((row) => row.scope !== 'user' || row.projectId != null)
      : destinationRows
  const preferences = await client.listCredentialPreferences({
    destinationSpaceId: address.destinationSpaceId,
  })
  const result = resolveCredential({
    userId: who.user.id,
    personalSpaceId,
    spaceId: address.destinationSpaceId,
    projectId: address.projectId,
    projectName: address.projectName,
    spaceName: address.spaceName,
    provider: address.provider,
    name: address.name,
    type: address.type,
    mode: address.mode,
    environment: address.environment,
    candidates: [
      ...destinationCandidates.map((row) => ({
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
      ...accountRows
        .filter((row) => row.scope === 'user' && row.projectId == null)
        .map((row) => ({
          row,
          spaceId: personalSpaceId!,
          projectId: row.projectId ?? null,
          payer: credentialPayerFromScope(row.scope),
          provider: row.provider,
          name: row.name,
          type: row.type,
          mode: row.mode,
          environment: row.environment,
          account: {
            ownerUserId: who.user.id,
            reachSpaceIds: row.reachSpaceIds ?? null,
          },
        })),
    ],
    preferences,
  })
  if (result.kind === 'refused') return result
  return { ...result, row: result.credential.row, ownerSpaceId: result.credential.spaceId }
}

export async function resolveHostedCredentialValue(
  address: CredentialResolutionAddress,
  client: ConfigClient = configClient(),
) {
  const result = await resolveHostedCredential(address, client)
  if (result.kind === 'refused') return result
  const value = await openHostedCredentialRowValue(result.row, result.ownerSpaceId, client)
  return {
    ...result,
    value,
  }
}

export async function openHostedCredentialRowValue(
  row: CredentialRow,
  ownerSpaceId: string,
  client: ConfigClient = configClient(),
): Promise<string> {
  const plaintext = await openHostedSecretRow(client, row, {
    destinationSpaceId: ownerSpaceId,
    projectId: row.projectId,
  })
  return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
}

export async function resolveActiveSpaceCredentialValue(
  identity: Pick<
    CredentialResolutionAddress,
    'provider' | 'name' | 'type' | 'mode' | 'environment'
  >,
  client: ConfigClient = configClient(),
) {
  const who = await client.whoami()
  if (!who.activeSpaceId) throw new Error(RECORD_ACTIVE_SPACE_REMEDY)
  const membership = recordSpaceMembership(
    who.activeSpaceId,
    parseRecordSpaceMemberships(who.memberships),
  )
  if (!membership) throw new Error(recordSpaceMembershipRefusal(who.activeSpaceId))
  return resolveHostedCredentialValue(
    {
      ...identity,
      projectId: null,
      spaceName: membership.slug,
      destinationSpaceId: who.activeSpaceId,
    },
    client,
  )
}
