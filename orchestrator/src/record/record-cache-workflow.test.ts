import { afterEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { effectiveProjectSpace, rememberProjectSpace } from '../project-space.ts'
import { productionStepCatalogue } from '../workflow/step-catalogue.ts'
import { productionWorkflowTree } from '../workflow/workflow-tree-store.ts'
import { productionWorkflows } from '../workflow/workflows.ts'
import { pullRecordCache } from './record-cache.ts'
import { applyWorkflowCatalogueRow, pullWorkflowCatalogue } from './record-cache-workflow.ts'

afterEach(() => installRecordApiClient(createMemoryRecordApiClient()))
const at = '2026-10-18T12:00:00.000Z'
const identity = (spaceId: string, slug: string, id = newRecordId()) => ({
  id,
  spaceId,
  slug,
  createdAt: at,
  updatedAt: at,
})
const version = (spaceId: string, ownerId: string, definition: unknown, id = newRecordId()) => ({
  id,
  spaceId,
  ownerId,
  n: 1,
  status: 'production',
  definition: JSON.stringify(definition),
  author: 'test',
  reason: 'test',
  createdAt: at,
  promotedAt: at,
  retiredAt: null,
  updatedAt: at,
})
const event = (spaceId: string, ownerVersionId: string, id = newRecordId()) => ({
  id,
  spaceId,
  ownerVersionId,
  event: 'promote',
  author: 'test',
  reason: 'test',
  sessionId: null,
  at,
})

test('workflow pull orders six durable streams, resumes pages, and holds an unresolved child', async () => {
  const local = db(),
    space = newRecordId(),
    catalogue = identity(space, 'shared'),
    catalogueVersion = version(space, catalogue.id, { steps: [] }),
    workflow = identity(space, 'flow'),
    workflowVersion = version(space, workflow.id, {
      title: 'Hosted',
      description: '',
      arguments: [],
      modes: [],
    })
  const items: Record<string, Record<string, unknown>> = {
    step_catalogue: catalogue,
    step_catalogue_version: catalogueVersion,
    step_catalogue_event: event(space, catalogueVersion.id),
    workflow,
    workflow_version: workflowVersion,
    workflow_event: event(space, workflowVersion.id),
  }
  const calls: string[] = [],
    pages = new Map<string, number>()
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    async listWorkflowCatalogue(table) {
      calls.push(table)
      const page = pages.get(table) ?? 0
      pages.set(table, page + 1)
      if (table === 'step_catalogue' && page === 0)
        return {
          items: [items[table]!],
          nextCursor:
            'eyJhdCI6IjIwMjYtMTAtMThUMTI6MDA6MDAuMDAwWiIsImlkIjoiMDE5YTAwMDAtMDAwMC03MDAwLTgwMDAtMDAwMDAwMDAwMDAxIn0',
        }
      if (table === 'step_catalogue' && page === 1) return { items: [], nextCursor: null }
      return { items: [items[table]!], nextCursor: null }
    },
  })
  expect(await pullWorkflowCatalogue(local, [space])).toEqual({
    count: 6,
    completedSpaces: new Set([space]),
  })
  expect(calls).toEqual([
    'step_catalogue',
    'step_catalogue',
    'step_catalogue_version',
    'step_catalogue_event',
    'workflow',
    'workflow_version',
    'workflow_event',
  ])
  expect(local.query('SELECT COUNT(*) n FROM workflow WHERE space_id IS NULL').get()).toEqual({
    n: 1,
  })

  const missingSpace = newRecordId(),
    missing = version(missingSpace, newRecordId(), {})
  const heldCalls: string[] = []
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    async listWorkflowCatalogue(table) {
      heldCalls.push(table)
      return table === 'step_catalogue_version'
        ? { items: [missing], nextCursor: null }
        : { items: [], nextCursor: null }
    },
  })
  expect(await pullWorkflowCatalogue(local, [missingSpace])).toEqual({
    count: 0,
    completedSpaces: new Set(),
  })
  expect(heldCalls).toEqual(['step_catalogue', 'step_catalogue_version'])
  expect(
    local
      .query('SELECT value FROM schema_meta WHERE key=?')
      .get(`record_workflow_cursor:${missingSpace}:step_catalogue_version`),
  ).toBeNull()
})

test('an unresolved workflow parent preserves prior project routing', async () => {
  const local = db(),
    oldSpace = newRecordId(),
    newSpace = newRecordId(),
    project = 'workflow-moving-project'
  upsertProject({
    recordId: newRecordId(),
    name: project,
    path: `/tmp/${project}`,
    settings: { space: 'new-space' },
  })
  rememberProjectSpace(local, project, oldSpace)
  const orphan = version(newSpace, newRecordId(), {})
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      user: { id: newRecordId(), email: 'pull@example.test' },
      activeSpaceId: oldSpace,
      personalSpaceId: oldSpace,
      memberships: [
        { space_id: oldSpace, slug: 'old-space', permission: 'write' },
        { space_id: newSpace, slug: 'new-space', permission: 'write' },
      ],
    }),
    listWorkflowCatalogue: async (table, _query, destination) => ({
      items:
        destination?.destinationSpaceId === newSpace && table === 'step_catalogue_version'
          ? [orphan]
          : [],
      nextCursor: null,
    }),
  })

  await pullRecordCache(local)
  expect(effectiveProjectSpace(local, project)).toBe(oldSpace)
})

test('the same workflow slug resolves through each project space without consuming local rows', () => {
  const local = db(),
    catalogueDefinition = productionStepCatalogue(local).definition
  const localDefinition = productionWorkflows(local)[0]!.definition
  const spaces = [newRecordId(), newRecordId()]
  for (const [index, space] of spaces.entries()) {
    const catalogue = identity(space!, 'shared')
    applyWorkflowCatalogueRow(local, 'step_catalogue', catalogue)
    applyWorkflowCatalogueRow(
      local,
      'step_catalogue_version',
      version(space!, catalogue.id, catalogueDefinition),
    )
    const workflow = identity(space!, 'fix-defect')
    applyWorkflowCatalogueRow(local, 'workflow', workflow)
    applyWorkflowCatalogueRow(
      local,
      'workflow_version',
      version(space!, workflow.id, { ...localDefinition, title: `Space ${index + 1}` }),
    )
    const project = `space-${index + 1}`
    upsertProject({ name: project, path: `/tmp/${project}`, recordId: newRecordId() })
    rememberProjectSpace(local, project, space!)
  }
  expect(productionWorkflowTree(local, 'space-1').workflows[0]!.definition.title).toBe('Space 1')
  expect(productionWorkflowTree(local, 'space-2').workflows[0]!.definition.title).toBe('Space 2')
  expect(productionWorkflows(local)[0]!.definition.title).not.toMatch(/^Space /)
})
