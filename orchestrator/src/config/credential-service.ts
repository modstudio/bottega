// concern: credential-service
/** Seals and addresses typed credentials without exposing plaintext to the hosted record. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  ConfigClientError,
  type ConfigDestination,
  type ConfigScope,
  type ConfigSecret,
  configClient,
  type DataKey,
} from '../../../shared/config-client.ts'
import { machineKeyInfo, readMachineKey } from '../../../shared/machine-key-store.ts'
import { sealedValueIsEmpty, stripTrailingNewline } from '../../../shared/sealed-value.ts'
import { sealValue, unwrapDataKey } from '../../../shared/secret-envelope.ts'
import { readTrustList } from '../../../shared/trust-list.ts'
import {
  type CredentialEnvironment,
  type CredentialPayer,
  credentialHint,
  credentialVariableName,
} from './credential.ts'

const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'))
const encoded = (value: Uint8Array) => Buffer.from(value).toString('base64url')
const isNotFound = (error: unknown) => error instanceof ConfigClientError && error.status === 404

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
const scope = (payer: CredentialPayer): ConfigScope => (payer === 'personal' ? 'user' : 'space')

function localMachine() {
  const pair = readMachineKey()
  if (!pair)
    throw new Error(
      `machine key is not initialized; run \`${PLATFORM_SLUG} machine config machine init\``,
    )
  return machineKeyInfo(pair)
}

async function openDataKey(key: DataKey, address: CredentialAddress): Promise<Uint8Array> {
  const machine = localMachine()
  const trust = await readTrustList()
  const wrap = key.wraps.find((row) => trust[row.senderKeyId])
  const sender = wrap && trust[wrap.senderKeyId]
  if (!wrap || !sender) throw missingProjectWrapRefusal(address)
  return unwrapDataKey({
    enc: bytes(wrap.enc),
    ciphertext: bytes(wrap.ciphertext),
    wrapContext: { spaceId: address.destinationSpaceId, dekId: key.id, dekVersion: key.version },
    recipientPrivateKey: machine.privateKey,
    senderPublicKey: bytes(sender.public_key),
    trustedSenderKeyIds: new Set(Object.keys(trust)),
  })
}

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
  if (sealedValueIsEmpty(value)) throw new Error('refusing to seal an empty credential')
  const machine = localMachine()
  const target = destination(address)
  let dataKey: DataKey
  try {
    dataKey = await client.currentDataKey(machine.keyId, target)
  } catch (error) {
    if (isNotFound(error)) throw missingProjectWrapRefusal(address)
    throw error
  }
  const dek = await openDataKey(dataKey, address)
  const key = credentialVariableName(address.provider, address.type, address.environment)
  const payerScope = scope(address.payer)
  let existing: ConfigSecret | null = null
  try {
    existing = await client.getSecret(key, payerScope, address.environment, target)
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  const plaintext = stripTrailingNewline(value)
  const current = await client.whoami()
  const envelope = sealValue({
    dek,
    plaintext: new TextEncoder().encode(plaintext),
    valueContext: {
      spaceId: address.destinationSpaceId,
      userId: payerScope === 'user' ? current.user.id : null,
      keyName: key,
      environment: address.environment,
      dekId: dataKey.id,
      rowVersion: (existing?.rowVersion ?? 0) + 1,
    },
  })
  return client.putSecret(key, {
    ...target,
    scope: payerScope,
    environment: address.environment,
    dekId: dataKey.id,
    envelope: encoded(envelope),
    expectedRowVersion: existing?.rowVersion ?? null,
    projectId: address.projectId,
    provider: address.provider,
    type: address.type,
    hint: credentialHint(plaintext),
  })
}

export async function listCredentials(spaceId: string, client = configClient()) {
  const target = { destinationSpaceId: spaceId }
  const rows = await Promise.all(
    (['default', 'live', 'test'] as const).map((env) => client.listSecrets(env, target)),
  )
  return rows.flat().filter((row) => row.provider && row.type)
}

export async function deleteCredential(address: CredentialAddress, client = configClient()) {
  const key = credentialVariableName(address.provider, address.type, address.environment)
  const payerScope = scope(address.payer)
  const target = destination(address)
  const row = await client.getSecret(key, payerScope, address.environment, target)
  return client.deleteSecret(key, {
    ...target,
    scope: payerScope,
    environment: address.environment,
    expectedRowVersion: row.rowVersion,
  })
}
