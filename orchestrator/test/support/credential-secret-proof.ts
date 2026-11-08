import { expect } from 'bun:test'
import type { ConfigTenant } from '../../src/record/record-config.ts'
import {
  deleteConfigSecret,
  getConfigSecret,
  putConfigSecret,
} from '../../src/record/record-config.ts'
import { succeeds } from '../fixtures/postgres-rls.ts'

export async function proveCredentialSecretProjectAddressing(input: {
  tenant: ConfigTenant
  dekId: string
  projectId: string
  foreignProjectId: string
}): Promise<void> {
  const identity = {
    ...input.tenant,
    key: 'ROUTED_API_KEY',
    mode: 'default' as const,
    environment: 'local',
    scope: 'user' as const,
    dekId: input.dekId,
    provider: 'routed',
    type: 'api-key',
    hint: 'rout…hint',
  }
  const spaceRow = await putConfigSecret({
    ...identity,
    projectId: null,
    envelope: Uint8Array.of(31),
    expectedRowVersion: null,
  })
  const projectRow = await putConfigSecret({
    ...identity,
    projectId: input.projectId,
    envelope: Uint8Array.of(32),
    expectedRowVersion: null,
  })
  expect(
    succeeds(
      'postgres',
      'postgres',
      `SELECT count(*) FROM config_secret
       WHERE space_id='${input.tenant.spaceId}' AND key='ROUTED_API_KEY'
         AND environment='local' AND user_id='${input.tenant.userId}';`,
    ),
  ).toBe('2')
  expect((await getConfigSecret({ ...identity, projectId: null }))?.envelope).toEqual(
    Uint8Array.of(31),
  )
  expect((await getConfigSecret({ ...identity, projectId: input.projectId }))?.envelope).toEqual(
    Uint8Array.of(32),
  )

  await putConfigSecret({
    ...identity,
    projectId: input.projectId,
    envelope: Uint8Array.of(33),
    expectedRowVersion: projectRow.rowVersion,
  })
  expect((await getConfigSecret({ ...identity, projectId: null }))?.rowVersion).toBe(
    spaceRow.rowVersion,
  )
  await putConfigSecret({
    ...identity,
    projectId: null,
    envelope: Uint8Array.of(34),
    expectedRowVersion: spaceRow.rowVersion,
  })
  expect((await getConfigSecret({ ...identity, projectId: input.projectId }))?.rowVersion).toBe(2)

  await deleteConfigSecret({ ...identity, projectId: input.projectId, expectedRowVersion: 2 })
  expect(await getConfigSecret({ ...identity, projectId: input.projectId })).toBeNull()
  expect(await getConfigSecret({ ...identity, projectId: null })).not.toBeNull()
  await deleteConfigSecret({ ...identity, projectId: null, expectedRowVersion: 2 })
  expect(await getConfigSecret({ ...identity, projectId: null })).toBeNull()

  await expect(
    putConfigSecret({
      ...identity,
      projectId: input.foreignProjectId,
      envelope: Uint8Array.of(35),
      expectedRowVersion: null,
    }),
  ).rejects.toMatchObject({ status: 422 })

  await expect(
    putConfigSecret({
      ...identity,
      key: 'PRODUCTION_API_KEY',
      environment: 'production',
      projectId: null,
      envelope: Uint8Array.of(36),
      expectedRowVersion: null,
    }),
  ).rejects.toThrow()

  const defaultMode = await putConfigSecret({
    ...identity,
    key: 'MODE_API_KEY',
    projectId: null,
    envelope: Uint8Array.of(37),
    expectedRowVersion: null,
  })
  const testMode = await putConfigSecret({
    ...identity,
    key: 'MODE_API_KEY_TEST',
    mode: 'test',
    projectId: null,
    envelope: Uint8Array.of(38),
    expectedRowVersion: null,
  })
  expect(
    succeeds(
      'postgres',
      'postgres',
      `SELECT string_agg(mode, ',' ORDER BY mode) FROM config_secret
       WHERE space_id='${input.tenant.spaceId}' AND provider='routed' AND type='api-key'
         AND key LIKE 'MODE_API_KEY%';`,
    ),
  ).toBe('default,test')
  await deleteConfigSecret({
    ...identity,
    key: defaultMode.key,
    projectId: null,
    expectedRowVersion: defaultMode.rowVersion,
  })
  await deleteConfigSecret({
    ...identity,
    key: testMode.key,
    projectId: null,
    expectedRowVersion: testMode.rowVersion,
  })
}
