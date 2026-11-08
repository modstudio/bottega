// concern: record-credential
/** Owns personal payer preferences in the hosted config schema. */

import type {
  CredentialPreference,
  CredentialPreferencePayload,
} from '../../../shared/credential.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { recordIso } from '../../../shared/record-timestamp.ts'
import { type ConfigTenant, requireConfigAccess, tenant } from './record-config.ts'

export type { CredentialPreference } from '../../../shared/credential.ts'

const preferenceRow = (row: Record<string, unknown>): CredentialPreference => ({
  projectId: row.project_id == null ? null : String(row.project_id),
  provider: String(row.provider),
  name: row.name == null ? null : String(row.name),
  type: String(row.type),
  mode: String(row.mode) as CredentialPreference['mode'],
  environment: String(row.environment) as CredentialPreference['environment'],
  payer: String(row.preferred_payer) as CredentialPreference['payer'],
  binding: String(row.preferred_binding) as CredentialPreference['binding'],
  updatedAt: recordIso(row.updated_at),
})

export async function listCredentialPreferences(input: ConfigTenant) {
  return tenant(input, async (tx) => {
    await requireConfigAccess(tx, input)
    const rows = await tx`SELECT project_id,provider,name,type,mode,environment,preferred_payer,
      preferred_binding,updated_at FROM credential_payer_preference
      WHERE space_id=${input.spaceId}::uuid AND user_id=${input.userId}::uuid
      ORDER BY provider,name NULLS FIRST,type,mode,environment,project_id NULLS FIRST`
    return rows.map((row: Record<string, unknown>) => preferenceRow(row))
  })
}

export async function putCredentialPreference(input: ConfigTenant & CredentialPreferencePayload) {
  return tenant(input, async (tx) => {
    await requireConfigAccess(tx, input)
    const rows = await tx`INSERT INTO credential_payer_preference
      (id,space_id,user_id,project_id,provider,name,type,mode,environment,preferred_payer,preferred_binding,updated_at)
      VALUES (${newRecordId()}::uuid,${input.spaceId}::uuid,${input.userId}::uuid,
        ${input.projectId}::uuid,${input.provider},${input.name},${input.type},${input.mode},${input.environment},
        ${input.payer},${input.binding},now())
      ON CONFLICT (space_id,user_id,project_id,provider,name,type,mode,environment)
      DO UPDATE SET preferred_payer=excluded.preferred_payer,
        preferred_binding=excluded.preferred_binding,updated_at=now()
      RETURNING project_id,provider,name,type,mode,environment,preferred_payer,preferred_binding,updated_at`
    return preferenceRow(rows[0] as Record<string, unknown>)
  })
}

export async function deleteCredentialPreference(
  input: ConfigTenant &
    Pick<CredentialPreference, 'projectId' | 'provider' | 'name' | 'type' | 'mode' | 'environment'>,
) {
  return tenant(input, async (tx) => {
    await requireConfigAccess(tx, input)
    await tx`DELETE FROM credential_payer_preference
      WHERE space_id=${input.spaceId}::uuid AND user_id=${input.userId}::uuid
        AND project_id IS NOT DISTINCT FROM ${input.projectId}::uuid
        AND provider=${input.provider} AND name IS NOT DISTINCT FROM ${input.name}
        AND type=${input.type} AND mode=${input.mode}
        AND environment=${input.environment}`
  })
}
