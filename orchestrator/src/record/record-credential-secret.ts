// concern: record-credential-secret
/** Maps hosted secret rows without exposing ciphertext on metadata surfaces. */

import type { CredentialEnvironment, CredentialMetadataFields } from '../../../shared/credential.ts'
import { recordIso } from '../../../shared/record-timestamp.ts'

type ConfigSecretBase = {
  id: string
  key: string
  environment: string
  scope: 'user' | 'space'
  projectId: string | null
  dekId: string
  rowVersion: number
  updatedAt: string
}
type LegacyConfigSecretMetadata = ConfigSecretBase & {
  projectId: null
  provider: null
  type: null
  hint: null
}
type CredentialSecretMetadata = ConfigSecretBase &
  CredentialMetadataFields & {
    environment: CredentialEnvironment
    projectId: string | null
  }
export type ConfigSecretMetadata = LegacyConfigSecretMetadata | CredentialSecretMetadata
export type ConfigSecret = ConfigSecretMetadata & { envelope: Uint8Array }

export function secretMetadata(row: Record<string, unknown>): ConfigSecretMetadata {
  return {
    id: String(row.id),
    key: String(row.key),
    environment: String(row.environment),
    scope: row.user_id == null ? 'space' : 'user',
    projectId: row.project_id == null ? null : String(row.project_id),
    provider: row.provider == null ? null : String(row.provider),
    type: row.type == null ? null : String(row.type),
    hint: row.hint == null ? null : String(row.hint),
    dekId: String(row.dek_id),
    rowVersion: Number(row.row_version),
    updatedAt: recordIso(row.updated_at),
  } as ConfigSecretMetadata
}
