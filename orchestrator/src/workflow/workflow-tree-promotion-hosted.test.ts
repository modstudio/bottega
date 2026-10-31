import { afterEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { rememberActiveRecordSpace, rememberProjectSpace } from '../project-space.ts'
import { applyWorkflowCatalogueRow } from '../record/record-cache-workflow.fixture.ts'
import { productionStepCatalogue } from './step-catalogue.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { productionWorkflowTree, promoteMatchingWorkflowTreeDrafts } from './workflow-tree-store.ts'
import { productionWorkflows } from './workflows.ts'

const database = testDatabaseFixture((d) => {
  seedWorkflows(d)
})
const hostedAt = '2026-10-20T12:00:00.000Z'

afterEach(() => {
  delete process.env.BOTTEGA_RECORD_API_URL
  installRecordApiClient(createMemoryRecordApiClient())
})

test('hosted promotion uses the project space instead of the active space', async () => {
  const d = database()
  const activeSpace = newRecordId()
  const projectSpace = newRecordId()
  const project = 'promotion-space-project'
  const catalogueDefinition = productionStepCatalogue(d).definition
  const workflowDefinition = productionWorkflows(d, null)[0]!.definition
  const catalogueId = newRecordId()
  const catalogueVersionId = newRecordId()
  const workflowId = newRecordId()
  const productionVersionId = newRecordId()
  const draftVersionId = newRecordId()
  const draftDefinition = { ...workflowDefinition, title: 'Project-space draft' }

  applyWorkflowCatalogueRow(d, 'step_catalogue', {
    id: catalogueId,
    spaceId: projectSpace,
    slug: 'shared',
    createdAt: hostedAt,
    updatedAt: hostedAt,
  })
  applyWorkflowCatalogueRow(d, 'step_catalogue_version', {
    id: catalogueVersionId,
    spaceId: projectSpace,
    ownerId: catalogueId,
    n: 1,
    status: 'production',
    definition: JSON.stringify(catalogueDefinition),
    author: 'test',
    reason: 'fixture',
    createdAt: hostedAt,
    promotedAt: hostedAt,
    retiredAt: null,
    updatedAt: hostedAt,
  })
  applyWorkflowCatalogueRow(d, 'workflow', {
    id: workflowId,
    spaceId: projectSpace,
    slug: 'space-fixture',
    createdAt: hostedAt,
    updatedAt: hostedAt,
  })
  for (const version of [
    {
      id: productionVersionId,
      n: 1,
      status: 'production' as const,
      definition: workflowDefinition,
      reason: 'fixture',
      promotedAt: hostedAt,
    },
    {
      id: draftVersionId,
      n: 2,
      status: 'draft' as const,
      definition: draftDefinition,
      reason: 'draft fixture',
      promotedAt: null,
    },
  ])
    applyWorkflowCatalogueRow(d, 'workflow_version', {
      ...version,
      spaceId: projectSpace,
      ownerId: workflowId,
      definition: JSON.stringify(version.definition),
      author: 'test',
      createdAt: hostedAt,
      retiredAt: null,
      updatedAt: hostedAt,
    })
  rememberActiveRecordSpace(d, activeSpace)
  rememberProjectSpace(d, project, projectSpace)
  d.exec("INSERT INTO record_install_binding(id,bound_at) VALUES (1,'2026-10-31')")

  const destinations: string[] = []
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      user: { id: newRecordId() },
      activeSpaceId: activeSpace,
      personalSpaceId: activeSpace,
      memberships: [
        {
          space_id: projectSpace,
          name: 'Project space',
          slug: 'project-space',
          role: 'owner',
          permission: 'write',
        },
      ],
    }),
    async listWorkflowCatalogue(table, _query, destination) {
      if (!destination?.destinationSpaceId) throw new Error('test expected a destination space')
      destinations.push(destination.destinationSpaceId)
      const items =
        table === 'step_catalogue'
          ? [
              {
                id: catalogueId,
                spaceId: projectSpace,
                slug: 'shared',
                createdAt: hostedAt,
                updatedAt: hostedAt,
              },
            ]
          : table === 'step_catalogue_version'
            ? [
                {
                  id: catalogueVersionId,
                  spaceId: projectSpace,
                  ownerId: catalogueId,
                  n: 1,
                  status: 'production',
                  definition: JSON.stringify(catalogueDefinition),
                  author: 'test',
                  reason: 'fixture',
                  createdAt: hostedAt,
                  promotedAt: hostedAt,
                  retiredAt: null,
                  updatedAt: hostedAt,
                },
              ]
            : table === 'workflow'
              ? [
                  {
                    id: workflowId,
                    spaceId: projectSpace,
                    slug: 'space-fixture',
                    createdAt: hostedAt,
                    updatedAt: hostedAt,
                  },
                ]
              : table === 'workflow_version'
                ? [
                    {
                      id: productionVersionId,
                      spaceId: projectSpace,
                      ownerId: workflowId,
                      n: 1,
                      status: 'production',
                      definition: JSON.stringify(workflowDefinition),
                      author: 'test',
                      reason: 'fixture',
                      createdAt: hostedAt,
                      promotedAt: hostedAt,
                      retiredAt: null,
                      updatedAt: hostedAt,
                    },
                    {
                      id: draftVersionId,
                      spaceId: projectSpace,
                      ownerId: workflowId,
                      n: 2,
                      status: 'draft',
                      definition: JSON.stringify(draftDefinition),
                      author: 'test',
                      reason: 'draft fixture',
                      createdAt: hostedAt,
                      promotedAt: null,
                      retiredAt: null,
                      updatedAt: hostedAt,
                    },
                  ]
                : []
      return { items, nextCursor: null }
    },
    async promoteWorkflow(input, destination) {
      if (!destination?.destinationSpaceId) throw new Error('test expected a destination space')
      destinations.push(destination.destinationSpaceId)
      return {
        identity: {
          id: workflowId,
          spaceId: projectSpace,
          slug: 'space-fixture',
          generation: 1,
          createdAt: hostedAt,
          updatedAt: hostedAt,
        },
        versions: [
          {
            id: productionVersionId,
            spaceId: projectSpace,
            ownerId: workflowId,
            n: 1,
            status: 'retired',
            definition: JSON.stringify(workflowDefinition),
            author: 'test',
            reason: 'fixture',
            createdAt: hostedAt,
            promotedAt: hostedAt,
            retiredAt: hostedAt,
            updatedAt: hostedAt,
          },
          {
            id: draftVersionId,
            spaceId: projectSpace,
            ownerId: workflowId,
            n: input.n,
            status: 'production',
            definition: JSON.stringify(draftDefinition),
            author: 'test',
            reason: 'draft fixture',
            createdAt: hostedAt,
            promotedAt: hostedAt,
            retiredAt: null,
            updatedAt: hostedAt,
          },
        ],
        events: [],
      }
    },
  })

  const tree = productionWorkflowTree({ database: d, project })
  tree.workflows[0]!.definition = draftDefinition
  const result = await promoteMatchingWorkflowTreeDrafts({
    tree,
    reason: 'promote project draft',
    author: 'test',
    database: d,
    project,
  })

  expect(result.promotions).toEqual([{ kind: 'workflow', slug: 'space-fixture', n: 2 }])
  expect(destinations).not.toContain(activeSpace)
  expect(new Set(destinations)).toEqual(new Set([projectSpace]))
})
