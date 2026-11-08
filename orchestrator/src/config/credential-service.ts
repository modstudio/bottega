// concern: credential-service
/** Seals and addresses typed credentials without exposing plaintext to the hosted record. */

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
import { sealedValueIsEmpty, stripTrailingNewline } from '../../../shared/sealed-value.ts'
import { configAccessRemedy, machineNotTrustedRemedy } from '../../../shared/record-remedies.ts'
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
import { openSecretInDestination } from './hosted-secret-destination.ts'

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

const destination = (address: CredentialAddress): ConfigDestination => ({
  destinationSpaceId: address.destinationSpaceId,
  projectId: address.projectId,
})
function missingProjectWrapRefusal(address: CredentialAddress): Error {
  const binding = address.projectName
    ? `project ${address.projectName} in space ${address.spaceName}`
    : `space ${address.spaceName}`
  return new Error(
    `cannot access credentials for ${binding}: ${machineNotTrustedRemedy(address.destinationSpaceId)}; ${configAccessRemedy(address.destinationSpaceId)}`,
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
  return { ...result, value: await openSecretInDestination(row, target, client) }
}
