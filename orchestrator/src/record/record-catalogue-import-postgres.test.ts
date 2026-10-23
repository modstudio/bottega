import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  importRecordLensCatalogue,
  importRecordPortCatalogue,
  importRecordWorkflowCatalogue,
} from './record-catalogue-import.ts'
import { ensureSpaceBuiltIns } from './record-space-built-ins.ts'
import { listRecordWorkflowCatalogue } from './record-workflow-catalogue.ts'

const actorUrl = process.env.BOTTEGA_TEST_CATALOGUE_IMPORT_URL
const setupUrl = process.env.BOTTEGA_TEST_CATALOGUE_IMPORT_SETUP_URL
const postgres = actorUrl && setupUrl ? describe : describe.skip

postgres('hosted catalogue bulk imports', () => {
  test('each complete import and built-in ensure is idempotent', async () => {
    const spaceId = newRecordId(),
      sourceSpaceId = newRecordId(),
      userId = newRecordId()
    const sourceProjectId = newRecordId(),
      targetProjectId = newRecordId()
    const setup = new SQL(setupUrl!)
    try {
      await setup`INSERT INTO "user" (id,email,name,email_verified,created_at,updated_at)
        VALUES (${userId}::uuid,${`${userId}@test.invalid`},'Catalogue Import',true,now(),now())`
      await setup`INSERT INTO space (id,name,slug,created_at)
        VALUES (${spaceId}::uuid,${`Catalogue ${spaceId}`},${`catalogue-${spaceId}`},now()),
          (${sourceSpaceId}::uuid,${`Source ${sourceSpaceId}`},${`source-${sourceSpaceId}`},now())`
      await setup`INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
        VALUES (${newRecordId()}::uuid,${spaceId}::uuid,${userId}::uuid,'owner','write',now())`
      await setup`INSERT INTO project (id,space_id,name,created_at) VALUES
        (${sourceProjectId}::uuid,${sourceSpaceId}::uuid,${`source-${spaceId}`},now()),
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
        {
          id: workflowId,
          spaceId,
          slug: `import-${spaceId}`,
          generation: 1,
          createdAt: at,
          updatedAt: at,
        },
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
    const pairId = newRecordId(),
      skipId = newRecordId(),
      refId = newRecordId(),
      sourceId = newRecordId()
    const port = {
      dryRun: false,
      replace: false,
      port_doctrine: [],
      port_pair: [{ id: pairId, spaceId, sourceProjectId, targetProjectId, createdAt: at }],
      port_baseline: [],
      port_ref: [
        {
          id: refId,
          spaceId,
          taskKey: 'TARGET-1',
          targetProjectId,
          note: 'cross-space source',
          createdAt: at,
          resolvedAt: null,
          deletedAt: null,
          version: 1,
          updatedAt: at,
        },
      ],
      port_ref_source: [
        {
          id: sourceId,
          spaceId,
          refId,
          sourceProjectId,
          commits: '[]',
          paths: '[]',
          note: 'source in another space',
          deletedAt: null,
          updatedAt: at,
        },
      ],
      port_skip: [
        {
          id: skipId,
          spaceId,
          pairId,
          candidate: 'candidate-one',
          reason: 'test',
          skippedAt: at,
        },
      ],
    }
    for (const run of [1, 2]) {
      const portInput =
        run === 1 ? port : { ...port, port_skip: [{ ...port.port_skip[0]!, id: newRecordId() }] }
      const results = await Promise.all([
        importRecordLensCatalogue({ ...tenant, ...lens }),
        importRecordWorkflowCatalogue({ ...tenant, ...workflow }),
        importRecordPortCatalogue({ ...tenant, ...portInput }),
      ])
      expect(results.map((result) => result.inserted)).toEqual(run === 1 ? [2, 2, 4] : [0, 0, 0])
    }
    const firstBuiltIns = await ensureSpaceBuiltIns(tenant)
    const secondBuiltIns = await ensureSpaceBuiltIns(tenant)
    expect(firstBuiltIns.inserted).toBeGreaterThan(0)
    expect(secondBuiltIns.inserted).toBe(0)
  })

  test('machine history replaces seeded workflow and step catalogue versions', async () => {
    const spaceId = newRecordId(),
      userId = newRecordId(),
      setup = new SQL(setupUrl!)
    try {
      await setup`INSERT INTO "user" (id,email,name,email_verified,created_at,updated_at)
        VALUES (${userId}::uuid,${`${userId}@test.invalid`},'Seed Replacement',true,now(),now())`
      await setup`INSERT INTO space (id,name,slug,created_at)
        VALUES (${spaceId}::uuid,${`Replacement ${spaceId}`},${`replacement-${spaceId}`},now())`
      await setup`INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
        VALUES (${newRecordId()}::uuid,${spaceId}::uuid,${userId}::uuid,'owner','write',now())`
    } finally {
      await setup.close()
    }
    const tenant = { url: actorUrl!, spaceId, spaceIds: [spaceId], userId },
      at = new Date().toISOString(),
      stepId = newRecordId(),
      workflowId = newRecordId(),
      stepDraftId = newRecordId(),
      stepProductionId = newRecordId(),
      workflowDraftId = newRecordId(),
      workflowProductionId = newRecordId(),
      stepEventId = newRecordId(),
      workflowEventId = newRecordId(),
      historicalAt = '2026-01-02T03:04:05.000Z'
    await ensureSpaceBuiltIns(tenant)
    const cursor = { at: new Date(Date.now() - 1_000).toISOString(), id: newRecordId() }
    const input = {
      dryRun: false,
      step_catalogue: [
        { id: stepId, spaceId, slug: 'shared', generation: 1, createdAt: at, updatedAt: at },
      ],
      step_catalogue_version: [
        {
          id: stepDraftId,
          spaceId,
          ownerId: stepId,
          n: 1,
          status: 'draft' as const,
          definition: '{"steps":[]}',
          author: 'machine',
          reason: 'local history',
          createdAt: at,
          promotedAt: null,
          retiredAt: null,
          updatedAt: at,
        },
        {
          id: stepProductionId,
          spaceId,
          ownerId: stepId,
          n: 2,
          status: 'production' as const,
          definition: '{"steps":[]}',
          author: 'machine',
          reason: 'local production',
          createdAt: at,
          promotedAt: at,
          retiredAt: null,
          updatedAt: at,
        },
      ],
      step_catalogue_event: [
        {
          id: stepEventId,
          spaceId,
          ownerVersionId: stepProductionId,
          event: 'promote' as const,
          author: 'machine',
          reason: 'local production',
          sessionId: null,
          at: historicalAt,
        },
      ],
      workflow: [
        {
          id: workflowId,
          spaceId,
          slug: 'fix-defect',
          generation: 1,
          createdAt: at,
          updatedAt: at,
        },
      ],
      workflow_version: [
        {
          id: workflowDraftId,
          spaceId,
          ownerId: workflowId,
          n: 1,
          status: 'draft' as const,
          definition: '{}',
          author: 'machine',
          reason: 'local history',
          createdAt: at,
          promotedAt: null,
          retiredAt: null,
          updatedAt: at,
        },
        {
          id: workflowProductionId,
          spaceId,
          ownerId: workflowId,
          n: 19,
          status: 'production' as const,
          definition: '{}',
          author: 'machine',
          reason: 'local production',
          createdAt: at,
          promotedAt: at,
          retiredAt: null,
          updatedAt: at,
        },
      ],
      workflow_event: [
        {
          id: workflowEventId,
          spaceId,
          ownerVersionId: workflowProductionId,
          event: 'promote' as const,
          author: 'machine',
          reason: 'local production',
          sessionId: null,
          at: historicalAt,
        },
      ],
    }
    const first = await importRecordWorkflowCatalogue({ ...tenant, ...input })
    expect(first.outcomes).toEqual([
      { kind: 'step_catalogue', slug: 'shared', outcome: 'replaced seeded built-in' },
      { kind: 'workflow', slug: 'fix-defect', outcome: 'replaced seeded built-in' },
    ])
    const verify = new SQL(setupUrl!)
    try {
      expect([
        ...(await verify`SELECT generation FROM step_catalogue WHERE space_id=${spaceId}::uuid AND slug='shared'`),
        ...(await verify`SELECT generation FROM workflow WHERE space_id=${spaceId}::uuid AND slug='fix-defect'`),
      ]).toEqual([{ generation: 2 }, { generation: 2 }])
      expect([
        ...(await verify`SELECT n,status,author FROM step_catalogue_version WHERE space_id=${spaceId}::uuid ORDER BY n`),
      ]).toEqual([
        { n: 1, status: 'draft', author: 'machine' },
        { n: 2, status: 'production', author: 'machine' },
      ])
      expect([
        ...(await verify`SELECT n,status,author FROM workflow_version WHERE space_id=${spaceId}::uuid ORDER BY n`),
      ]).toEqual([
        { n: 1, status: 'draft', author: 'machine' },
        { n: 19, status: 'production', author: 'machine' },
      ])
      expect([
        ...(await verify`SELECT COUNT(*)::int n FROM step_catalogue_event WHERE space_id=${spaceId}::uuid`),
      ]).toEqual([{ n: 1 }])
      expect([
        ...(await verify`SELECT COUNT(*)::int n FROM workflow_event WHERE space_id=${spaceId}::uuid`),
      ]).toEqual([{ n: 1 }])
    } finally {
      await verify.close()
    }
    const stepEvents = await listRecordWorkflowCatalogue({
        ...tenant,
        table: 'step_catalogue_event',
        limit: 100,
        cursor,
      }),
      workflowEvents = await listRecordWorkflowCatalogue({
        ...tenant,
        table: 'workflow_event',
        limit: 100,
        cursor,
      })
    expect(stepEvents).toEqual([expect.objectContaining({ id: stepEventId, at: historicalAt })])
    expect(workflowEvents).toEqual([
      expect.objectContaining({ id: workflowEventId, at: historicalAt }),
    ])
    expect(new Date(String(stepEvents[0]!.updatedAt)).getTime()).toBeGreaterThan(
      new Date(cursor.at).getTime(),
    )
    expect(new Date(String(workflowEvents[0]!.updatedAt)).getTime()).toBeGreaterThan(
      new Date(cursor.at).getTime(),
    )
    const second = await importRecordWorkflowCatalogue({ ...tenant, ...input })
    expect(second.inserted).toBe(0)
    expect(second.outcomes).toEqual([])
  })

  test('a person-authored draft prevents replacing a seeded production or importing events', async () => {
    const spaceId = newRecordId(),
      userId = newRecordId(),
      personDraftId = newRecordId(),
      personEventId = newRecordId(),
      importedWorkflowId = newRecordId(),
      importedProductionId = newRecordId(),
      importedEventId = newRecordId(),
      setup = new SQL(setupUrl!)
    try {
      await setup`INSERT INTO "user" (id,email,name,email_verified,created_at,updated_at)
        VALUES (${userId}::uuid,${`${userId}@test.invalid`},'Mixed History',true,now(),now())`
      await setup`INSERT INTO space (id,name,slug,created_at)
        VALUES (${spaceId}::uuid,${`Mixed ${spaceId}`},${`mixed-${spaceId}`},now())`
      await setup`INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
        VALUES (${newRecordId()}::uuid,${spaceId}::uuid,${userId}::uuid,'owner','write',now())`
    } finally {
      await setup.close()
    }
    const tenant = { url: actorUrl!, spaceId, spaceIds: [spaceId], userId }
    await ensureSpaceBuiltIns(tenant)
    const write = new SQL(setupUrl!)
    let hostedWorkflowId: string
    try {
      const owners =
        await write`SELECT id FROM workflow WHERE space_id=${spaceId}::uuid AND slug='fix-defect'`
      hostedWorkflowId = String(owners[0]!.id)
      await write`INSERT INTO workflow_version
        (id,space_id,workflow_id,n,status,definition,author,reason,created_at,updated_at)
        VALUES (${personDraftId}::uuid,${spaceId}::uuid,${hostedWorkflowId}::uuid,2,'draft',
          '{"person":true}','person','person draft',now(),now())`
      await write`INSERT INTO workflow_event
        (id,space_id,workflow_version_id,event,author,reason,session_id,at,updated_at)
        VALUES (${personEventId}::uuid,${spaceId}::uuid,${personDraftId}::uuid,'set','person',
          'person draft',NULL,now(),now())`
    } finally {
      await write.close()
    }
    const before = new SQL(setupUrl!)
    let versionsBefore: unknown[], eventsBefore: unknown[]
    try {
      versionsBefore = [
        ...(await before`SELECT id,n,status,author,definition FROM workflow_version WHERE space_id=${spaceId}::uuid AND workflow_id=${hostedWorkflowId}::uuid ORDER BY n`),
      ]
      eventsBefore = [
        ...(await before`SELECT id,workflow_version_id,event,author,reason FROM workflow_event WHERE space_id=${spaceId}::uuid AND workflow_version_id IN (SELECT id FROM workflow_version WHERE workflow_id=${hostedWorkflowId}::uuid) ORDER BY id`),
      ]
    } finally {
      await before.close()
    }
    const at = new Date().toISOString()
    const result = await importRecordWorkflowCatalogue({
      ...tenant,
      dryRun: false,
      step_catalogue: [],
      step_catalogue_version: [],
      step_catalogue_event: [],
      workflow: [
        {
          id: importedWorkflowId,
          spaceId,
          slug: 'fix-defect',
          generation: 1,
          createdAt: at,
          updatedAt: at,
        },
      ],
      workflow_version: [
        {
          id: importedProductionId,
          spaceId,
          ownerId: importedWorkflowId,
          n: 19,
          status: 'production',
          definition: '{"local":true}',
          author: 'machine',
          reason: 'local production',
          createdAt: at,
          promotedAt: at,
          retiredAt: null,
          updatedAt: at,
        },
      ],
      workflow_event: [
        {
          id: importedEventId,
          spaceId,
          ownerVersionId: importedProductionId,
          event: 'promote',
          author: 'machine',
          reason: 'local production',
          sessionId: null,
          at,
        },
      ],
    })
    expect(result.outcomes).toEqual([
      {
        kind: 'workflow',
        slug: 'fix-defect',
        outcome: 'kept hosted history; local history not imported',
      },
    ])
    const verify = new SQL(setupUrl!)
    try {
      expect([
        ...(await verify`SELECT id,n,status,author,definition FROM workflow_version WHERE space_id=${spaceId}::uuid AND workflow_id=${hostedWorkflowId}::uuid ORDER BY n`),
      ]).toEqual(versionsBefore)
      expect([
        ...(await verify`SELECT id,workflow_version_id,event,author,reason FROM workflow_event WHERE space_id=${spaceId}::uuid AND workflow_version_id IN (SELECT id FROM workflow_version WHERE workflow_id=${hostedWorkflowId}::uuid) ORDER BY id`),
      ]).toEqual(eventsBefore)
      expect([
        ...(await verify`SELECT id FROM workflow_event WHERE id=${importedEventId}::uuid`),
      ]).toEqual([])
    } finally {
      await verify.close()
    }
  })

  test('a retired seed-only history is replaced without a production gate', async () => {
    const spaceId = newRecordId(),
      userId = newRecordId(),
      importedWorkflowId = newRecordId(),
      importedDraftId = newRecordId(),
      setup = new SQL(setupUrl!)
    try {
      await setup`INSERT INTO "user" (id,email,name,email_verified,created_at,updated_at)
        VALUES (${userId}::uuid,${`${userId}@test.invalid`},'Retired Seed',true,now(),now())`
      await setup`INSERT INTO space (id,name,slug,created_at)
        VALUES (${spaceId}::uuid,${`Retired ${spaceId}`},${`retired-${spaceId}`},now())`
      await setup`INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
        VALUES (${newRecordId()}::uuid,${spaceId}::uuid,${userId}::uuid,'owner','write',now())`
    } finally {
      await setup.close()
    }
    const tenant = { url: actorUrl!, spaceId, spaceIds: [spaceId], userId }
    await ensureSpaceBuiltIns(tenant)
    const retire = new SQL(setupUrl!)
    let seededVersionId: string
    try {
      const rows = await retire`UPDATE workflow_version SET status='retired',promoted_at=NULL,
        retired_at=now(),updated_at=now() WHERE space_id=${spaceId}::uuid
        AND workflow_id=(SELECT id FROM workflow WHERE space_id=${spaceId}::uuid AND slug='fix-defect')
        RETURNING id`
      seededVersionId = String(rows[0]!.id)
    } finally {
      await retire.close()
    }
    const historical = '2020-01-01T00:00:00.000Z'
    const result = await importRecordWorkflowCatalogue({
      ...tenant,
      dryRun: false,
      step_catalogue: [],
      step_catalogue_version: [],
      step_catalogue_event: [],
      workflow: [
        {
          id: importedWorkflowId,
          spaceId,
          slug: 'fix-defect',
          generation: 1,
          createdAt: historical,
          updatedAt: historical,
        },
      ],
      workflow_version: [
        {
          id: importedDraftId,
          spaceId,
          ownerId: importedWorkflowId,
          n: 9,
          status: 'draft',
          definition: '{"local":true}',
          author: 'machine',
          reason: 'local retired-era history',
          createdAt: historical,
          promotedAt: null,
          retiredAt: null,
          updatedAt: historical,
        },
      ],
      workflow_event: [],
    })
    expect(result.outcomes).toEqual([
      { kind: 'workflow', slug: 'fix-defect', outcome: 'replaced seeded built-in' },
    ])
    const verify = new SQL(setupUrl!)
    try {
      expect([
        ...(await verify`SELECT id,n,status,author,created_at,updated_at
          FROM workflow_version WHERE space_id=${spaceId}::uuid
          AND workflow_id=(SELECT id FROM workflow WHERE space_id=${spaceId}::uuid AND slug='fix-defect')`),
      ]).toEqual([
        {
          id: importedDraftId,
          n: 9,
          status: 'draft',
          author: 'machine',
          created_at: new Date(historical),
          updated_at: expect.any(Date),
        },
      ])
      const [timestamps] =
        await verify`SELECT created_at,updated_at FROM workflow_version WHERE id=${importedDraftId}::uuid`
      expect(new Date(String(timestamps!.updated_at)).getTime()).toBeGreaterThan(
        new Date(String(timestamps!.created_at)).getTime(),
      )
      expect([
        ...(await verify`SELECT id FROM workflow_version WHERE id=${seededVersionId}::uuid`),
      ]).toEqual([])
    } finally {
      await verify.close()
    }
  })

  test('newer natural-key matches stay unchanged and reject imported workflow children', async () => {
    const spaceId = newRecordId(),
      userId = newRecordId(),
      sourceProjectId = newRecordId(),
      targetProjectId = newRecordId(),
      hostedLensId = newRecordId(),
      hostedWorkflowId = newRecordId(),
      hostedWorkflowVersionId = newRecordId(),
      hostedPairId = newRecordId(),
      hostedBaselineId = newRecordId(),
      importedLensId = newRecordId(),
      importedWorkflowId = newRecordId(),
      importedWorkflowVersionId = newRecordId(),
      importedPairId = newRecordId(),
      at = new Date().toISOString()
    const setup = new SQL(setupUrl!)
    try {
      await setup`INSERT INTO "user" (id,email,name,email_verified,created_at,updated_at)
        VALUES (${userId}::uuid,${`${userId}@test.invalid`},'Natural Match',true,now(),now())`
      await setup`INSERT INTO space (id,name,slug,created_at)
        VALUES (${spaceId}::uuid,${`Natural ${spaceId}`},${`natural-${spaceId}`},now())`
      await setup`INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
        VALUES (${newRecordId()}::uuid,${spaceId}::uuid,${userId}::uuid,'owner','write',now())`
      await setup`INSERT INTO project (id,space_id,name,created_at) VALUES
        (${sourceProjectId}::uuid,${spaceId}::uuid,${`source-${spaceId}`},now()),
        (${targetProjectId}::uuid,${spaceId}::uuid,${`target-${spaceId}`},now())`
      await setup`INSERT INTO lens
        (id,space_id,key,title,question,excludes,slots,version,enabled,requires_execution,updated_at)
        VALUES (${hostedLensId}::uuid,${spaceId}::uuid,'natural-lens','hosted newer','hosted?',
          'nothing','{}',9,true,false,now())`
      await setup`INSERT INTO workflow (id,space_id,slug,created_at,updated_at)
        VALUES (${hostedWorkflowId}::uuid,${spaceId}::uuid,'natural-workflow',now(),now())`
      await setup`INSERT INTO workflow_version
        (id,space_id,workflow_id,n,status,definition,author,reason,created_at,promoted_at,updated_at)
        VALUES (${hostedWorkflowVersionId}::uuid,${spaceId}::uuid,${hostedWorkflowId}::uuid,1,
          'production','{"hosted":true}','hosted','newer',now(),now(),now())`
      await setup`INSERT INTO port_pair (id,space_id,source_project_id,target_project_id,created_at)
        VALUES (${hostedPairId}::uuid,${spaceId}::uuid,${sourceProjectId}::uuid,${targetProjectId}::uuid,now())`
      await setup`INSERT INTO port_baseline
        (id,space_id,pair_id,source_commit,scanned_at,version,updated_at)
        VALUES (${hostedBaselineId}::uuid,${spaceId}::uuid,${hostedPairId}::uuid,'hosted-newer',now(),9,now())`
    } finally {
      await setup.close()
    }
    const tenant = { url: actorUrl!, spaceId, spaceIds: [spaceId], userId }
    const profileId = newRecordId(),
      workflowEventId = newRecordId(),
      skipId = newRecordId()
    await importRecordLensCatalogue({
      ...tenant,
      dryRun: false,
      lens: [
        {
          id: importedLensId,
          spaceId,
          key: 'natural-lens',
          title: 'old',
          question: 'old?',
          excludes: 'old',
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
          lensId: importedLensId,
          axis: 'framework',
          name: 'imported',
          version: 1,
          body: '{}',
          enabled: true,
          updatedAt: at,
        },
      ],
      lens_profile_revision: [],
      project_lens_profile: [],
      project_lens_profile_revision: [],
    })
    const workflowResult = await importRecordWorkflowCatalogue({
      ...tenant,
      dryRun: false,
      step_catalogue: [],
      step_catalogue_version: [],
      step_catalogue_event: [],
      workflow: [
        {
          id: importedWorkflowId,
          spaceId,
          slug: 'natural-workflow',
          generation: 1,
          createdAt: at,
          updatedAt: at,
        },
      ],
      workflow_version: [
        {
          id: importedWorkflowVersionId,
          spaceId,
          ownerId: importedWorkflowId,
          n: 1,
          status: 'production',
          definition: '{"hosted":false}',
          author: 'import',
          reason: 'old',
          createdAt: at,
          promotedAt: at,
          retiredAt: null,
          updatedAt: at,
        },
      ],
      workflow_event: [
        {
          id: workflowEventId,
          spaceId,
          ownerVersionId: importedWorkflowVersionId,
          event: 'set',
          author: 'import',
          reason: 'child',
          sessionId: null,
          at,
        },
      ],
    })
    expect(workflowResult.outcomes).toEqual([
      {
        kind: 'workflow',
        slug: 'natural-workflow',
        outcome: 'kept hosted history; local history not imported',
      },
    ])
    await importRecordPortCatalogue({
      ...tenant,
      dryRun: false,
      replace: false,
      port_doctrine: [],
      port_pair: [{ id: importedPairId, spaceId, sourceProjectId, targetProjectId, createdAt: at }],
      port_baseline: [
        {
          id: newRecordId(),
          spaceId,
          pairId: importedPairId,
          sourceCommit: 'old',
          scannedAt: at,
          version: 1,
          updatedAt: at,
        },
      ],
      port_ref: [],
      port_ref_source: [],
      port_skip: [
        {
          id: skipId,
          spaceId,
          pairId: importedPairId,
          candidate: 'child',
          reason: 'child',
          skippedAt: at,
        },
      ],
    })
    const verify = new SQL(setupUrl!)
    try {
      expect([
        ...(await verify`SELECT id,title,version FROM lens WHERE space_id=${spaceId}::uuid AND key='natural-lens'`),
      ]).toEqual([{ id: hostedLensId, title: 'hosted newer', version: 9 }])
      expect([
        ...(await verify`SELECT lens_id FROM lens_profile WHERE id=${profileId}::uuid`),
      ]).toEqual([{ lens_id: hostedLensId }])
      expect([
        ...(await verify`SELECT id,definition,author FROM workflow_version WHERE space_id=${spaceId}::uuid AND workflow_id=${hostedWorkflowId}::uuid AND n=1`),
      ]).toEqual([{ id: hostedWorkflowVersionId, definition: '{"hosted":true}', author: 'hosted' }])
      expect([
        ...(await verify`SELECT workflow_version_id FROM workflow_event WHERE id=${workflowEventId}::uuid`),
      ]).toEqual([])
      expect([
        ...(await verify`SELECT id,source_commit,version FROM port_baseline WHERE space_id=${spaceId}::uuid AND pair_id=${hostedPairId}::uuid`),
      ]).toEqual([{ id: hostedBaselineId, source_commit: 'hosted-newer', version: 9 }])
      expect([...(await verify`SELECT pair_id FROM port_skip WHERE id=${skipId}::uuid`)]).toEqual([
        { pair_id: hostedPairId },
      ])
    } finally {
      await verify.close()
    }
  })
})
