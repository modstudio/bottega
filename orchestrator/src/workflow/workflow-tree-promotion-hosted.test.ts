import { afterEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
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

test('a hosted removed production step names the workflow draft promotion before promote-tree', async () => {
  const d = database()
  const projectSpace = newRecordId()
  const project = 'hosted-removal-project'
  const productionCatalogue = structuredClone(productionStepCatalogue(d).definition)
  const productionWorkflow = structuredClone(productionWorkflows(d, null)[0]!)
  const removedStep = productionWorkflow.definition.modes
    .flatMap(({ steps }) => steps)
    .find((step): step is string => typeof step === 'string')!
  const draftCatalogue = {
    ...productionCatalogue,
    steps: productionCatalogue.steps.filter(({ slug }) => slug !== removedStep),
  }
  const draftWorkflow = {
    ...productionWorkflow.definition,
    modes: productionWorkflow.definition.modes.map((mode) => ({
      ...mode,
      steps: mode.steps.filter((step) => step !== removedStep),
    })),
  }
  const catalogueId = newRecordId()
  const workflowId = newRecordId()
  const catalogueVersions = [
    {
      id: newRecordId(),
      spaceId: projectSpace,
      ownerId: catalogueId,
      n: 1,
      status: 'production' as const,
      definition: JSON.stringify(productionCatalogue),
      author: 'test',
      reason: 'fixture',
      createdAt: hostedAt,
      promotedAt: hostedAt,
      retiredAt: null,
      updatedAt: hostedAt,
    },
    {
      id: newRecordId(),
      spaceId: projectSpace,
      ownerId: catalogueId,
      n: 2,
      status: 'draft' as const,
      definition: JSON.stringify(draftCatalogue),
      author: 'test',
      reason: 'drop step fixture',
      createdAt: hostedAt,
      promotedAt: null,
      retiredAt: null,
      updatedAt: hostedAt,
    },
  ]
  const workflowVersions = [
    {
      id: newRecordId(),
      spaceId: projectSpace,
      ownerId: workflowId,
      n: 1,
      status: 'production' as const,
      definition: JSON.stringify(productionWorkflow.definition),
      author: 'test',
      reason: 'fixture',
      createdAt: hostedAt,
      promotedAt: hostedAt,
      retiredAt: null,
      updatedAt: hostedAt,
    },
    {
      id: newRecordId(),
      spaceId: projectSpace,
      ownerId: workflowId,
      n: 2,
      status: 'draft' as const,
      definition: JSON.stringify(draftWorkflow),
      author: 'test',
      reason: 'drop step reference fixture',
      createdAt: hostedAt,
      promotedAt: null,
      retiredAt: null,
      updatedAt: hostedAt,
    },
  ]
  const catalogue = {
    id: catalogueId,
    spaceId: projectSpace,
    slug: 'shared',
    createdAt: hostedAt,
    updatedAt: hostedAt,
  }
  const workflow = {
    id: workflowId,
    spaceId: projectSpace,
    slug: productionWorkflow.slug,
    createdAt: hostedAt,
    updatedAt: hostedAt,
  }

  applyWorkflowCatalogueRow(d, 'step_catalogue', catalogue)
  for (const version of catalogueVersions)
    applyWorkflowCatalogueRow(d, 'step_catalogue_version', version)
  applyWorkflowCatalogueRow(d, 'workflow', workflow)
  for (const version of workflowVersions) applyWorkflowCatalogueRow(d, 'workflow_version', version)
  rememberProjectSpace(d, project, projectSpace)
  d.exec("INSERT INTO record_install_binding(id,bound_at) VALUES (1,'2026-10-31')")

  process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      user: { id: newRecordId() },
      activeSpaceId: projectSpace,
      personalSpaceId: projectSpace,
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
    async listWorkflowCatalogue(table) {
      const items =
        table === 'step_catalogue'
          ? [catalogue]
          : table === 'step_catalogue_version'
            ? catalogueVersions
            : table === 'workflow'
              ? [workflow]
              : table === 'workflow_version'
                ? workflowVersions
                : []
      return { items, nextCursor: null }
    },
  })

  const tree = productionWorkflowTree({ database: d, project })
  tree.steps = draftCatalogue.steps
  tree.workflows[0]!.definition = draftWorkflow
  const refusal = await promoteMatchingWorkflowTreeDrafts({
    tree,
    reason: 'promote matching hosted removal',
    author: 'test',
    database: d,
    project,
  }).then(
    () => null,
    (cause: unknown) => cause,
  )

  const workflowRemedy = `${PLATFORM_SLUG} workflow promote ${productionWorkflow.slug} 2`
  const treeRemedy = `${PLATFORM_SLUG} workflow promote-tree`
  expect(refusal).toBeInstanceOf(Error)
  if (!(refusal instanceof Error)) throw new Error('expected hosted catalogue promotion refusal')
  expect(refusal.message).toContain(`space ${projectSpace}`)
  expect(refusal.message).toContain(workflowRemedy)
  expect(refusal.message.indexOf(workflowRemedy)).toBeLessThan(refusal.message.indexOf(treeRemedy))
})
