/** Shared credential identity vocabulary and hosted payloads. */

export const CREDENTIAL_SLUG_SOURCE = '^[a-z0-9]+(?:-[a-z0-9]+)*$'
export const CREDENTIAL_SLUG_PATTERN = new RegExp(CREDENTIAL_SLUG_SOURCE)
export const CREDENTIAL_ENVIRONMENTS = ['live', 'test', 'default'] as const
export const CREDENTIAL_PAYERS = ['personal', 'shared'] as const
export const CREDENTIAL_BINDINGS = ['project', 'space'] as const

export type CredentialEnvironment = (typeof CREDENTIAL_ENVIRONMENTS)[number]
export type CredentialPayer = (typeof CREDENTIAL_PAYERS)[number]
export type CredentialBinding = (typeof CREDENTIAL_BINDINGS)[number]

export type CredentialMetadataFields = {
  provider: string
  type: string
  hint: string
}

export type CredentialIdentity = Pick<CredentialMetadataFields, 'provider' | 'type'> & {
  projectId: string | null
  environment: CredentialEnvironment
}

export type CredentialPreferencePayload = CredentialIdentity & {
  payer: CredentialPayer
  binding: CredentialBinding
}

export type CredentialPreference = CredentialPreferencePayload & { updatedAt: string }

export type CompleteCredentialFields = CredentialMetadataFields & {
  environment: CredentialEnvironment
}

export function completeCredentialFields(row: {
  provider?: string | null
  type?: string | null
  hint?: string | null
  environment: string
}): CompleteCredentialFields | null {
  if (
    row.provider == null ||
    row.type == null ||
    row.hint == null ||
    !CREDENTIAL_ENVIRONMENTS.includes(row.environment as CredentialEnvironment)
  )
    return null
  return {
    provider: row.provider,
    type: row.type,
    hint: row.hint,
    environment: row.environment as CredentialEnvironment,
  }
}
