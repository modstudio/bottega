import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { applyMigrations, applyMigrationsBefore } from '../database/migrations.ts'
import { upsertProject } from '../project/projects.ts'
import { effectiveProjectSpace, rememberProjectSpace } from '../project-space.ts'
import { productionStepCatalogue } from '../workflow/step-catalogue.ts'
import { productionWorkflowTree } from '../workflow/workflow-tree-store.ts'
import { productionWorkflows } from '../workflow/workflows.ts'
import { pullRecordCache } from './record-cache.ts'
import {
  applyWorkflowCatalogueRow,
  applyWorkflowWriteResponse,
  pullWorkflowCatalogue,
} from './record-cache-workflow.ts'
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

const catalogueKinds = [
  ['workflow', 'workflow', 'workflow_version', 'workflow_event', 'fix-defect'],
  ['step catalogue', 'step_catalogue', 'step_catalogue_version', 'step_catalogue_event', 'shared'],
] as const

const identityDisagreements = catalogueKinds.flatMap(
  ([kind, identityTable, versionTable, eventTable, slug]) => [
    [kind, 'lower generation', identityTable, versionTable, eventTable, slug, false] as const,
    [kind, 'different identity id', identityTable, versionTable, eventTable, slug, true] as const,
  ],
)

test.each(identityDisagreements)(
  'pull with persisted cursors replays a %s after a %s',
  async (_kind, _case, identityTable, versionTable, eventTable, slug, replaceId) => {
    const local = db(),
      space = newRecordId(),
      cachedId = newRecordId(),
      hostedId = replaceId ? newRecordId() : cachedId,
      cachedIdentity = { ...identity(space, slug, cachedId), generation: replaceId ? 1 : 2 },
      retired = {
        ...version(space, cachedId, { title: 'Retired cache' }),
        status: 'retired',
        promotedAt: null,
        retiredAt: at,
      },
      production = {
        ...version(space, cachedId, { title: 'Production cache' }),
        n: 69,
      },
      hostedIdentity = {
        ...identity(space, slug, hostedId),
        updatedAt: '2026-10-20T12:00:00.000Z',
      },
      hostedVersion = version(space, hostedId, { title: 'Hosted' }),
      hostedEvent = event(space, hostedVersion.id),
      consumed = { at: '2026-10-19T12:00:00.000Z', id: newRecordId() }
    applyWorkflowCatalogueRow(local, identityTable, cachedIdentity)
    applyWorkflowCatalogueRow(local, versionTable, retired)
    applyWorkflowCatalogueRow(local, versionTable, production)
    applyWorkflowCatalogueRow(local, eventTable, event(space, retired.id))
    applyWorkflowCatalogueRow(local, eventTable, event(space, production.id))
    for (const table of [identityTable, versionTable, eventTable])
      local
        .query('INSERT INTO schema_meta (key,value) VALUES (?,?)')
        .run(`record_workflow_cursor:${space}:${table}`, JSON.stringify(consumed))

    installRecordApiClient({
      ...createMemoryRecordApiClient(),
      async listWorkflowCatalogue(table, query) {
        if (table === identityTable) {
          expect(query.cursor).toBe(encodeRecordCursor(consumed))
          return { items: [hostedIdentity], nextCursor: null }
        }
        if (table === versionTable) {
          expect(query.cursor).toBeUndefined()
          return { items: [hostedVersion], nextCursor: null }
        }
        if (table === eventTable) {
          expect(query.cursor).toBeUndefined()
          return { items: [hostedEvent], nextCursor: null }
        }
        return { items: [], nextCursor: null }
      },
    })

    expect(await pullWorkflowCatalogue(local, [space])).toEqual({
      count: 3,
      completedSpaces: new Set([space]),
    })
    expect(
      local
        .query(`SELECT record_id,generation FROM ${identityTable} WHERE space_id=? AND slug=?`)
        .all(space, slug),
    ).toEqual([{ record_id: hostedId, generation: 1 }])
    expect(
      local.query(`SELECT record_id,n,status FROM ${versionTable} WHERE space_id=?`).all(space),
    ).toEqual([{ record_id: hostedVersion.id, n: 1, status: 'production' }])
    expect(local.query(`SELECT record_id FROM ${eventTable} WHERE space_id=?`).all(space)).toEqual([
      { record_id: hostedEvent.id },
    ])
  },
)

const writeReconciliations = catalogueKinds.flatMap(
  ([label, identityTable, versionTable, eventTable, slug]) => [
    [label, 'lower generation', identityTable, versionTable, eventTable, slug, false] as const,
    [label, 'different identity id', identityTable, versionTable, eventTable, slug, true] as const,
  ],
)

test.each(writeReconciliations)(
  'hosted %s write completes event replay after a %s reconciliation',
  async (_label, _case, identityTable, versionTable, eventTable, slug, replaceId) => {
    const local = db(),
      space = newRecordId(),
      cachedId = newRecordId(),
      hostedId = replaceId ? newRecordId() : cachedId,
      cachedIdentity = { ...identity(space, slug, cachedId), generation: replaceId ? 1 : 2 },
      cachedVersion = version(space, cachedId, { title: 'Cached' }),
      hostedIdentity = identity(space, slug, hostedId),
      hostedVersion = {
        ...version(space, hostedId, { title: 'Hosted' }),
        status: 'production' as const,
      },
      historicalEvent = { ...event(space, hostedVersion.id), event: 'set' as const },
      changedEvent = { ...event(space, hostedVersion.id), event: 'promote' as const },
      consumed = { at: '2026-10-19T12:00:00.000Z', id: newRecordId() }
    applyWorkflowCatalogueRow(local, identityTable, cachedIdentity)
    applyWorkflowCatalogueRow(local, versionTable, cachedVersion)
    applyWorkflowCatalogueRow(local, eventTable, event(space, cachedVersion.id))
    for (const table of [identityTable, versionTable, eventTable])
      local
        .query('INSERT INTO schema_meta (key,value) VALUES (?,?)')
        .run(`record_workflow_cursor:${space}:${table}`, JSON.stringify(consumed))

    installRecordApiClient({
      ...createMemoryRecordApiClient(),
      async listWorkflowCatalogue(table, query) {
        if (table === versionTable) {
          expect(query.cursor).toBeUndefined()
          return { items: [hostedVersion], nextCursor: null }
        }
        if (table === eventTable) {
          expect(query.cursor).toBeUndefined()
          return { items: [historicalEvent, changedEvent], nextCursor: null }
        }
        return { items: [], nextCursor: null }
      },
    })

    await applyWorkflowWriteResponse(local, identityTable, {
      identity: hostedIdentity,
      versions: [hostedVersion],
      events: [changedEvent],
    })

    expect(
      local.query(`SELECT record_id FROM ${identityTable} WHERE space_id=?`).all(space),
    ).toEqual([{ record_id: hostedId }])
    expect(
      local.query(`SELECT record_id FROM ${versionTable} WHERE space_id=?`).all(space),
    ).toEqual([{ record_id: hostedVersion.id }])
    expect(
      local
        .query(`SELECT record_id FROM ${eventTable} WHERE space_id=? ORDER BY record_id`)
        .all(space),
    ).toEqual(
      [historicalEvent.id, changedEvent.id].sort().map((recordId) => ({ record_id: recordId })),
    )
  },
)

test.each(catalogueKinds)(
  'pull with persisted cursors replaces a cached %s seed with the complete paged history',
  async (_kind, identityTable, versionTable, eventTable, slug) => {
    const local = db(),
      space = newRecordId(),
      hostedIdentity = identity(space, slug),
      seeded = version(space, hostedIdentity.id, { title: 'Seed' }),
      seededEvent = event(space, seeded.id),
      sharedUpdatedAt = '2026-10-19T15:00:00.123456Z',
      replacementIdentity = {
        ...hostedIdentity,
        generation: 2,
        updatedAt: '2026-10-19T14:30:00.000Z',
      },
      replacements = Array.from({ length: 101 }, (_, index) => ({
        ...version(space, hostedIdentity.id, { title: `Hosted ${index + 2}` }),
        id: newRecordId(),
        n: index + 2,
        status: index + 2 === 69 ? 'production' : 'retired',
        promotedAt: index + 2 === 69 ? at : null,
        retiredAt: index + 2 === 69 ? null : at,
        updatedAt: sharedUpdatedAt,
      })),
      identityCursor = { at: '2026-10-19T14:00:00.000Z', id: newRecordId() },
      versionCursor = { at: '2026-10-19T14:00:00.000Z', id: newRecordId() },
      eventCursor = { at: '2026-10-19T14:00:00.000Z', id: newRecordId() },
      importedEvents = replacements.map((replacement) => ({
        ...event(space, replacement.id),
        updatedAt: sharedUpdatedAt,
      })),
      versionPageCursor = {
        at: sharedUpdatedAt,
        id: replacements[99]!.id,
      },
      eventPageCursor = {
        at: sharedUpdatedAt,
        id: importedEvents[99]!.id,
      }
    applyWorkflowCatalogueRow(local, identityTable, hostedIdentity)
    applyWorkflowCatalogueRow(local, versionTable, seeded)
    applyWorkflowCatalogueRow(local, eventTable, seededEvent)
    local
      .query('INSERT INTO schema_meta (key,value) VALUES (?,?),(?,?),(?,?)')
      .run(
        `record_workflow_cursor:${space}:${identityTable}`,
        JSON.stringify(identityCursor),
        `record_workflow_cursor:${space}:${versionTable}`,
        JSON.stringify(versionCursor),
        `record_workflow_cursor:${space}:${eventTable}`,
        JSON.stringify(eventCursor),
      )
    const calls = new Map<string, number>()
    installRecordApiClient({
      ...createMemoryRecordApiClient(),
      async listWorkflowCatalogue(table, query) {
        const call = calls.get(table) ?? 0
        calls.set(table, call + 1)
        if (table === identityTable) {
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
        if (table === versionTable) {
          expect(query.cursor).toBe(call === 0 ? undefined : encodeRecordCursor(versionPageCursor))
          const items = call === 0 ? replacements.slice(0, 100) : replacements.slice(100)
          return {
            items,
            nextCursor: call === 0 ? encodeRecordCursor(versionPageCursor) : null,
            endCursor: encodeRecordCursor({
              at: sharedUpdatedAt,
              id: items.at(-1)!.id,
            }),
          }
        }
        if (table === eventTable) {
          expect(query.cursor).toBe(call === 0 ? undefined : encodeRecordCursor(eventPageCursor))
          const items = call === 0 ? importedEvents.slice(0, 100) : importedEvents.slice(100)
          return {
            items,
            nextCursor: call === 0 ? encodeRecordCursor(eventPageCursor) : null,
            endCursor: encodeRecordCursor({
              at: sharedUpdatedAt,
              id: items.at(-1)!.id,
            }),
          }
        }
        return { items: [], nextCursor: null }
      },
    })
    expect(await pullWorkflowCatalogue(local, [space])).toEqual({
      count: 203,
      completedSpaces: new Set([space]),
    })
    expect(
      local.query(`SELECT COUNT(*) n FROM ${versionTable} WHERE space_id=?`).get(space),
    ).toEqual({ n: replacements.length })
    expect(
      local
        .query(`SELECT n FROM ${versionTable} WHERE space_id=? AND status='production'`)
        .all(space),
    ).toEqual([{ n: 69 }])
    expect(local.query(`SELECT COUNT(*) n FROM ${eventTable} WHERE space_id=?`).get(space)).toEqual(
      {
        n: importedEvents.length,
      },
    )
    expect(
      local
        .query(`SELECT record_id FROM ${versionTable} WHERE space_id=? ORDER BY record_id`)
        .all(space)
        .map((row) => (row as { record_id: string }).record_id),
    ).toEqual(replacements.map((row) => row.id).sort())
    expect(
      local
        .query(`SELECT record_id FROM ${eventTable} WHERE space_id=? ORDER BY record_id`)
        .all(space)
        .map((row) => (row as { record_id: string }).record_id),
    ).toEqual(importedEvents.map((row) => row.id).sort())
    expect(
      local.query(`SELECT COUNT(*) n FROM ${versionTable} WHERE space_id=? AND n=1`).get(space),
    ).toEqual({ n: 0 })
    expect(calls.get(versionTable)).toBe(2)
    expect(calls.get(eventTable)).toBe(2)
  },
)

test('generation migration resets old-client cursors so replacement history replays', async () => {
  const local = new Database(':memory:')
  try {
    applyMigrationsBefore(local, '0128_workflow_catalogue_generation')
    const space = newRecordId(),
      workflowId = newRecordId(),
      seedVersionId = newRecordId(),
      replacementIdentity = {
        ...identity(space, 'fix-defect', workflowId),
        generation: 2,
        updatedAt: '2026-10-19T14:30:00.000Z',
      },
      replacement = {
        ...version(space, workflowId, { title: 'Machine history' }),
        id: newRecordId(),
        n: 2,
        updatedAt: '2026-10-19T15:00:00.000Z',
      },
      importedEvent = {
        ...event(space, replacement.id),
        at: '2026-10-18T11:00:00.000Z',
        updatedAt: '2026-10-19T15:00:01.000Z',
      }
    const parent = local
      .query(
        `INSERT INTO workflow (record_id,space_id,slug,created_at)
         VALUES (?,?,?,?) RETURNING id`,
      )
      .get(workflowId, space, 'fix-defect', at) as { id: number }
    local
      .query(
        `INSERT INTO workflow_version
         (record_id,space_id,workflow_id,n,status,definition,author,reason,created_at,promoted_at)
         VALUES (?,?,?,1,'production',?,'seed','seed r1',?,?)`,
      )
      .run(seedVersionId, space, parent.id, JSON.stringify({ title: 'Seed' }), at, at)
    local
      .query(
        `INSERT INTO workflow_event
         (record_id,space_id,workflow_id,version_n,event,author,reason,at)
         VALUES (?,?,?,1,'promote','seed','seed r1',?)`,
      )
      .run(newRecordId(), space, parent.id, at)
    const consumed = JSON.stringify({ at: '2026-10-19T16:00:00.000Z', id: newRecordId() })
    for (const table of [
      'step_catalogue',
      'step_catalogue_version',
      'step_catalogue_event',
      'workflow',
      'workflow_version',
      'workflow_event',
    ])
      local
        .query('INSERT INTO schema_meta (key,value) VALUES (?,?)')
        .run(`record_workflow_cursor:${space}:${table}`, consumed)

    expect(applyMigrations(local)).toContain('0128_workflow_catalogue_generation')
    expect(
      local
        .query("SELECT COUNT(*) AS n FROM schema_meta WHERE key GLOB 'record_workflow_cursor:*'")
        .get(),
    ).toEqual({ n: 0 })

    installRecordApiClient({
      ...createMemoryRecordApiClient(),
      async listWorkflowCatalogue(table, query) {
        expect(query.cursor).toBeUndefined()
        if (table === 'workflow') return { items: [replacementIdentity], nextCursor: null }
        if (table === 'workflow_version') return { items: [replacement], nextCursor: null }
        if (table === 'workflow_event') return { items: [importedEvent], nextCursor: null }
        return { items: [], nextCursor: null }
      },
    })
    expect(await pullWorkflowCatalogue(local, [space])).toEqual({
      count: 3,
      completedSpaces: new Set([space]),
    })
    expect(
      local.query('SELECT record_id,n FROM workflow_version WHERE space_id=?').all(space),
    ).toEqual([{ record_id: replacement.id, n: 2 }])
    expect(local.query('SELECT record_id FROM workflow_event WHERE space_id=?').all(space)).toEqual(
      [{ record_id: importedEvent.id }],
    )
  } finally {
    local.close()
  }
})
