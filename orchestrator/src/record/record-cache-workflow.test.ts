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
import { encodeRecordCursor } from './record-cursor.ts'

afterEach(() => installRecordApiClient(createMemoryRecordApiClient()))
const at = '2026-10-18T12:00:00.000Z'
const identity = (spaceId: string, slug: string, id = newRecordId()) => ({
  id,
  spaceId,
  slug,
  generation: 1,
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
  updatedAt: at,
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

test('pull with a persisted cursor replaces a cached seed version and its events', async () => {
  const local = db(),
    space = newRecordId(),
    hostedIdentity = identity(space, 'fix-defect'),
    seeded = version(space, hostedIdentity.id, { title: 'Seed' }),
    seededEvent = event(space, seeded.id),
    replacementIdentity = {
      ...hostedIdentity,
      generation: 2,
      updatedAt: '2026-10-19T14:30:00.000Z',
    },
    replacement = {
      ...version(space, hostedIdentity.id, { title: 'Machine history' }),
      id: newRecordId(),
      n: 2,
      updatedAt: '2026-10-19T15:00:00.000Z',
    },
    importedEvent = {
      ...event(space, replacement.id),
      at: '2026-10-18T11:00:00.000Z',
      updatedAt: '2026-10-19T15:00:01.000Z',
    },
    identityCursor = { at: '2026-10-19T14:00:00.000Z', id: newRecordId() },
    versionCursor = { at: '2026-10-19T14:00:00.000Z', id: newRecordId() },
    eventCursor = { at: '2026-10-19T14:00:00.000Z', id: newRecordId() }
  applyWorkflowCatalogueRow(local, 'workflow', hostedIdentity)
  applyWorkflowCatalogueRow(local, 'workflow_version', seeded)
  applyWorkflowCatalogueRow(local, 'workflow_event', seededEvent)
  local
    .query('INSERT INTO schema_meta (key,value) VALUES (?,?),(?,?),(?,?)')
    .run(
      `record_workflow_cursor:${space}:workflow`,
      JSON.stringify(identityCursor),
      `record_workflow_cursor:${space}:workflow_version`,
      JSON.stringify(versionCursor),
      `record_workflow_cursor:${space}:workflow_event`,
      JSON.stringify(eventCursor),
    )
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    async listWorkflowCatalogue(table, query) {
      if (table === 'workflow') {
        expect(query.cursor).toBe(encodeRecordCursor(identityCursor))
        return {
          items: [replacementIdentity],
          nextCursor: null,
          endCursor: encodeRecordCursor({
            at: replacementIdentity.updatedAt,
            id: replacementIdentity.id,
          }),
        }
      }
      if (table === 'workflow_version') {
        expect(query.cursor).toBe(encodeRecordCursor(versionCursor))
        return {
          items: [replacement],
          nextCursor: null,
          endCursor: encodeRecordCursor({ at: replacement.updatedAt, id: replacement.id }),
        }
      }
      if (table === 'workflow_event') {
        expect(query.cursor).toBe(encodeRecordCursor(eventCursor))
        return {
          items: [importedEvent],
          nextCursor: null,
          endCursor: encodeRecordCursor({ at: importedEvent.updatedAt, id: importedEvent.id }),
        }
      }
      return { items: [], nextCursor: null }
    },
  })
  expect(await pullWorkflowCatalogue(local, [space])).toEqual({
    count: 3,
    completedSpaces: new Set([space]),
  })
  expect(
    local.query('SELECT record_id,n,definition FROM workflow_version WHERE space_id=?').get(space),
  ).toEqual({ record_id: replacement.id, n: 2, definition: replacement.definition })
  expect(
    local.query('SELECT record_id FROM workflow_event WHERE space_id=? ORDER BY id').all(space),
  ).toEqual([{ record_id: importedEvent.id }])
})
