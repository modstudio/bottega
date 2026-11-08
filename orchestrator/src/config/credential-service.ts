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
import { sealedValueIsEmpty, stripTrailingNewline } from '../../../shared/sealed-value.ts'
import { deleteSecret, openSecretInDestination, setSecret } from './config-service.ts'
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
    `cannot access credentials for ${binding}: this machine is not trusted in that space; from a machine trusted there, run \`${PLATFORM_SLUG} machine config machine trust <keyId> <publicKey>\``,
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

/** Resolve and open one project credential; plaintext exists only in the returned memory value. */
export async function resolveCredentialValue(
  address: CredentialAddress,
  client = configClient(),
): Promise<string> {
  if (!address.projectId || !address.projectName)
    throw new Error('credential value resolution requires a project binding')
  const rows = await listCredentials(address.destinationSpaceId, {}, client)
  const preferences = await client.listCredentialPreferences({
    destinationSpaceId: address.destinationSpaceId,
  })
  const result = resolveCredential({
    spaceId: address.destinationSpaceId,
    projectId: address.projectId,
    projectName: address.projectName,
    ...address,
    candidates: rows.map((row) => ({
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
  const row = rows.find(
    (candidate) =>
      candidate.provider === result.credential.provider &&
      candidate.name === result.credential.name &&
      candidate.type === result.credential.type &&
      candidate.mode === result.credential.mode &&
      candidate.environment === result.credential.environment &&
      candidate.projectId === result.credential.projectId &&
      credentialPayerFromScope(candidate.scope) === result.credential.payer,
  )
  if (!row) throw missingCredentialRefusal(address)
  const target = { destinationSpaceId: address.destinationSpaceId, projectId: row.projectId }
  return openSecretInDestination(row, target, client)
}
