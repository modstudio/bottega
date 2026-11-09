/** Shared credential identity vocabulary and hosted payloads. */

export const CREDENTIAL_SLUG_SOURCE = '^[a-z0-9]+(?:-[a-z0-9]+)*$'
export const CREDENTIAL_SLUG_PATTERN = new RegExp(CREDENTIAL_SLUG_SOURCE)
export const CREDENTIAL_MODES = ['live', 'test', 'default'] as const
export const CREDENTIAL_ENVIRONMENTS = ['local'] as const
export const CREDENTIAL_PAYERS = ['personal', 'shared'] as const
export const CREDENTIAL_BINDINGS = ['project', 'space', 'account'] as const

export type CredentialMode = (typeof CREDENTIAL_MODES)[number]
export type CredentialEnvironment = (typeof CREDENTIAL_ENVIRONMENTS)[number]
export type CredentialPayer = (typeof CREDENTIAL_PAYERS)[number]
export type CredentialBinding = (typeof CREDENTIAL_BINDINGS)[number]

export type CredentialMetadataFields = {
  provider: string
  name: string | null
  type: string
  hint: string
}

export type CredentialIdentity = Pick<CredentialMetadataFields, 'provider' | 'name' | 'type'> & {
  projectId: string | null
  mode: CredentialMode
  environment: CredentialEnvironment
}

export type CredentialPreferencePayload = CredentialIdentity & {
  payer: CredentialPayer
  binding: CredentialBinding
}

export type CredentialPreference = CredentialPreferencePayload & { updatedAt: string }

export type CompleteCredentialFields = CredentialMetadataFields & {
  mode: CredentialMode
  environment: CredentialEnvironment
}

/** Render the stable slash-delimited path for one credential identity. */
export function credentialIdentityPath(
  provider: string,
  name: string | null,
  type: string,
): string {
  return [provider, name, type].filter((part): part is string => part !== null).join('/')
}

/** Canonical hosted identity key. This is storage identity, never a delivery variable name. */
export function credentialIdentityKey(fields: {
  provider: string
  name: string | null
  type: string
  mode: CredentialMode
  environment: CredentialEnvironment
}): string {
  const name = credentialIdentityPath(fields.provider, fields.name, fields.type)
  return `${name}#${fields.mode}@${fields.environment}`
}

export function completeCredentialFields(row: {
  provider?: string | null
  name?: string | null
  type?: string | null
  hint?: string | null
  mode?: string | null
  environment: string
}): CompleteCredentialFields | null {
  if (
    row.provider == null ||
    row.type == null ||
    row.hint == null ||
    row.mode == null ||
    !CREDENTIAL_MODES.includes(row.mode as CredentialMode) ||
    !CREDENTIAL_ENVIRONMENTS.includes(row.environment as CredentialEnvironment)
  )
    return null
  return {
    provider: row.provider,
    name: row.name ?? null,
    type: row.type,
    hint: row.hint,
    mode: row.mode as CredentialMode,
    environment: row.environment as CredentialEnvironment,
  }
}
