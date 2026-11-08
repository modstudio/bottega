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
  CREDENTIAL_ENVIRONMENTS,
  type CredentialMetadataFields,
} from '../../../shared/credential.ts'
import { stripTrailingNewline } from '../../../shared/sealed-value.ts'
import {
  type CredentialEnvironment,
  type CredentialPayer,
  credentialHint,
  credentialScopeFromPayer,
  credentialVariableName,
} from './credential.ts'
import { deleteSecret, setSecret } from './config-service.ts'

export type CredentialAddress = {
  provider: string
  type: string
  environment: CredentialEnvironment
  payer: CredentialPayer
  projectId: string | null
  projectName?: string
  spaceName: string
  destinationSpaceId: string
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
    `cannot access credentials for ${binding}: this machine has no data-key wrap in that space; run \`${PLATFORM_SLUG} record space switch ${address.spaceName}\`, then \`${PLATFORM_SLUG} record space access grant\``,
  )
}

export async function setCredential(
  address: CredentialAddress,
  value: string,
  client = configClient(),
) {
  try {
    return await setSecret(
      credentialVariableName(address.provider, address.type, address.environment),
      stripTrailingNewline(value),
      credentialScopeFromPayer(address.payer),
      client,
      {
        destination: destination(address),
        environment: address.environment,
        metadata: {
          projectId: address.projectId,
          provider: address.provider,
          type: address.type,
          hint: credentialHint(stripTrailingNewline(value)),
        },
        createDataKey: false,
      },
    )
  } catch (error) {
    if (error instanceof ConfigClientError && error.status === 404)
      throw missingProjectWrapRefusal(address)
    throw error
  }
}

type CredentialRow = ConfigSecret &
  CredentialMetadataFields & { environment: CredentialEnvironment }

function isCredentialRow(row: ConfigSecret): row is CredentialRow {
  return (
    row.provider !== null &&
    row.provider !== undefined &&
    row.type !== null &&
    row.type !== undefined &&
    row.hint !== null &&
    row.hint !== undefined &&
    CREDENTIAL_ENVIRONMENTS.includes(row.environment as CredentialEnvironment)
  )
}

export async function listCredentials(
  spaceId: string,
  filters: { environment?: CredentialEnvironment; projectId?: string } = {},
  client = configClient(),
): Promise<CredentialRow[]> {
  const target = { destinationSpaceId: spaceId }
  const environments = filters.environment ? [filters.environment] : CREDENTIAL_ENVIRONMENTS
  const rows = await Promise.all(environments.map((env) => client.listSecrets(env, target)))
  return rows
    .flat()
    .filter(isCredentialRow)
    .filter((row) => filters.projectId === undefined || row.projectId === filters.projectId)
}

export async function deleteCredential(address: CredentialAddress, client = configClient()) {
  const key = credentialVariableName(address.provider, address.type, address.environment)
  return deleteSecret(key, credentialScopeFromPayer(address.payer), client, {
    destination: destination(address),
    environment: address.environment,
  })
}
