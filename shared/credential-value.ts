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
import { RECORD_ACTIVE_SPACE_REMEDY } from './record-remedies.ts'

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

type CredentialRow = ConfigSecret & CompleteCredentialFields

async function listCredentials(spaceId: string, client: ConfigClient): Promise<CredentialRow[]> {
  const destination = { destinationSpaceId: spaceId }
  const rows = await Promise.all(
    CREDENTIAL_ENVIRONMENTS.map((environment) => client.listSecrets(environment, destination)),
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
  const rows = await listCredentials(address.destinationSpaceId, client)
  const preferences = await client.listCredentialPreferences({
    destinationSpaceId: address.destinationSpaceId,
  })
  const result = resolveCredential({
    spaceId: address.destinationSpaceId,
    projectId: address.projectId,
    projectName: address.projectName,
    spaceName: address.spaceName,
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
  if (result.kind === 'refused') return result
  return { ...result, row: result.credential.row }
}

export async function resolveHostedCredentialValue(
  address: CredentialResolutionAddress,
  client: ConfigClient = configClient(),
) {
  const result = await resolveHostedCredential(address, client)
  if (result.kind === 'refused') return result
  const target = {
    destinationSpaceId: address.destinationSpaceId,
    projectId: result.row.projectId,
  }
  const plaintext = await openHostedSecretRow(client, result.row, target)
  return {
    ...result,
    value: new TextDecoder('utf-8', { fatal: true }).decode(plaintext),
  }
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
  const membership = who.memberships.find((row) => row.space_id === who.activeSpaceId)
  return resolveHostedCredentialValue(
    {
      ...identity,
      projectId: null,
      spaceName: membership?.slug ?? who.activeSpaceId,
      destinationSpaceId: who.activeSpaceId,
    },
    client,
  )
}
