import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  importRecordLensCatalogue,
  importRecordPortCatalogue,
  importRecordWorkflowCatalogue,
} from './record-catalogue-import.ts'
import { ensureSpaceBuiltIns } from './record-space-built-ins.ts'

const actorUrl = process.env.ORCH_TEST_CATALOGUE_IMPORT_URL
const setupUrl = process.env.ORCH_TEST_CATALOGUE_IMPORT_SETUP_URL
const postgres = actorUrl && setupUrl ? describe : describe.skip

postgres('hosted catalogue bulk imports', () => {
  test('each complete import and built-in ensure is idempotent', async () => {
    const spaceId = newRecordId(),
      userId = newRecordId()
    const sourceProjectId = newRecordId(),
      targetProjectId = newRecordId()
    const setup = new SQL(setupUrl!)
    try {
      await setup`INSERT INTO "user" (id,email,name,email_verified,created_at,updated_at)
        VALUES (${userId}::uuid,${`${userId}@test.invalid`},'Catalogue Import',true,now(),now())`
      await setup`INSERT INTO space (id,name,slug,created_at)
        VALUES (${spaceId}::uuid,${`Catalogue ${spaceId}`},${`catalogue-${spaceId}`},now())`
      await setup`INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
        VALUES (${newRecordId()}::uuid,${spaceId}::uuid,${userId}::uuid,'owner','write',now())`
      await setup`INSERT INTO project (id,space_id,name,created_at) VALUES
        (${sourceProjectId}::uuid,${spaceId}::uuid,${`source-${spaceId}`},now()),
        (${targetProjectId}::uuid,${spaceId}::uuid,${`target-${spaceId}`},now())`
    } finally {
      await setup.close()
    }
    const tenant = { url: actorUrl!, spaceId, spaceIds: [spaceId], userId }
    const at = new Date().toISOString(),
      lensId = newRecordId(),
      profileId = newRecordId()
    const lens = {
      dryRun: false,
      lens: [
        {
          id: lensId,
          spaceId,
          key: `import-${spaceId}`,
          title: 'Import',
          question: 'Works?',
          excludes: 'Nothing.',
          slots: '{}',
          version: 1,
          enabled: true,
          requiresExecution: false,
          updatedAt: at,
        },
      ],
      lens_revision: [],
      lens_profile: [
        {
          id: profileId,
          spaceId,
          lensId,
          axis: 'framework' as const,
          name: 'default',
          version: 1,
          body: '{}',
          enabled: true,
          updatedAt: at,
        },
      ],
      lens_profile_revision: [],
      project_lens_profile: [],
      project_lens_profile_revision: [],
    }
    const workflowId = newRecordId(),
      workflowVersionId = newRecordId()
    const workflow = {
      dryRun: false,
      step_catalogue: [],
      step_catalogue_version: [],
      step_catalogue_event: [],
      workflow: [
        { id: workflowId, spaceId, slug: `import-${spaceId}`, createdAt: at, updatedAt: at },
      ],
      workflow_version: [
        {
          id: workflowVersionId,
          spaceId,
          ownerId: workflowId,
          n: 1,
          status: 'production' as const,
          definition: '{}',
          author: 'test',
          reason: 'test',
          createdAt: at,
          promotedAt: at,
          retiredAt: null,
          updatedAt: at,
        },
      ],
      workflow_event: [],
    }
    const pairId = newRecordId()
    const port = {
      dryRun: false,
      replace: false,
      port_doctrine: [],
      port_pair: [{ id: pairId, spaceId, sourceProjectId, targetProjectId, createdAt: at }],
      port_baseline: [],
      port_ref: [],
      port_ref_source: [],
      port_skip: [],
    }
    for (const run of [1, 2]) {
      const results = await Promise.all([
        importRecordLensCatalogue({ ...tenant, ...lens }),
        importRecordWorkflowCatalogue({ ...tenant, ...workflow }),
        importRecordPortCatalogue({ ...tenant, ...port }),
      ])
      expect(results.map((result) => result.inserted)).toEqual(run === 1 ? [2, 2, 1] : [0, 0, 0])
    }
    const firstBuiltIns = await ensureSpaceBuiltIns(tenant)
    const secondBuiltIns = await ensureSpaceBuiltIns(tenant)
    expect(firstBuiltIns.inserted).toBeGreaterThan(0)
    expect(secondBuiltIns.inserted).toBe(0)
  })
})
