import { expect } from 'bun:test'
import type { CredentialPreference } from '../../../shared/credential.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import type { ConfigTenant } from '../../src/record/record-config.ts'
import {
  deleteCredentialPreference,
  listCredentialPreferences,
  putCredentialPreference,
} from '../../src/record/record-credential.ts'
import { succeeds } from './postgres-rls.ts'

export async function proveCredentialPreferencePersistence(input: {
  tenant: ConfigTenant
  spaceId: string
  userId: string
  otherUserId: string
  projectId: string
}): Promise<void> {
  const identity = {
    ...input.tenant,
    provider: 'preference-proof',
    type: 'api-key',
    environment: 'test' as const,
  }
  await putCredentialPreference({
    ...identity,
    projectId: input.projectId,
    payer: 'personal',
    binding: 'project',
  })
  await putCredentialPreference({
    ...identity,
    projectId: input.projectId,
    payer: 'shared',
    binding: 'space',
  })
  expect(
    succeeds(
      'postgres',
      'postgres',
      `SELECT count(*) FROM credential_payer_preference
       WHERE space_id='${input.spaceId}' AND user_id='${input.userId}' AND project_id='${input.projectId}'
         AND provider='preference-proof' AND type='api-key' AND environment='test';`,
    ),
  ).toBe('1')
  expect(
    (await listCredentialPreferences(input.tenant)).find(
      (row: CredentialPreference) =>
        row.provider === identity.provider && row.projectId === input.projectId,
    ),
  ).toMatchObject({ payer: 'shared', binding: 'space', environment: 'test' })

  await putCredentialPreference({
    ...identity,
    projectId: null,
    payer: 'personal',
    binding: 'space',
  })
  succeeds(
    'postgres',
    'postgres',
    `INSERT INTO credential_payer_preference
     (id,space_id,user_id,project_id,provider,type,environment,preferred_payer,preferred_binding,updated_at)
     VALUES ('${newRecordId()}','${input.spaceId}','${input.otherUserId}',NULL,'preference-proof','api-key','test','shared','space',now());`,
  )
  await deleteCredentialPreference({ ...identity, projectId: input.projectId })
  await deleteCredentialPreference({ ...identity, projectId: null })
  expect(
    succeeds(
      'postgres',
      'postgres',
      `SELECT user_id FROM credential_payer_preference
       WHERE space_id='${input.spaceId}' AND provider='preference-proof'
       ORDER BY user_id;`,
    ),
  ).toBe(input.otherUserId)
}
