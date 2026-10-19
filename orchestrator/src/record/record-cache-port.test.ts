import { afterEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { ledgerRef, listLedgerRefs, setLedgerRefLocal } from '../porting/porting.ts'
import { upsertProject } from '../project/projects.ts'
import { effectiveProjectSpace, rememberProjectSpace } from '../project-space.ts'
import { pullRecordCache } from './record-cache.ts'
import { applyPortCatalogueRow, pullPortCatalogue } from './record-cache-port.ts'
import { encodeRecordCursor } from './record-cursor.ts'

afterEach(() => installRecordApiClient(createMemoryRecordApiClient()))
const at = '2026-10-18T12:00:00.000Z'
const doctrine = (spaceId: string, id = newRecordId()) => ({
  id,
  spaceId,
  number: 1,
  title: 'Hosted',
  body: 'Hosted body.',
  createdAt: at,
  retiredAt: null,
  version: 1,
  updatedAt: at,
})

test('port pull orders six durable streams, resumes pages, and holds an unresolved child', async () => {
  const local = db()
  const space = newRecordId()
  const calls: string[] = []
  const pages = new Map<string, number>()
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    async listPortCatalogue(table) {
      calls.push(table)
      const page = pages.get(table) ?? 0
      pages.set(table, page + 1)
      if (table === 'port_doctrine' && page === 0)
        return { items: [doctrine(space)], nextCursor: 'next' }
      return { items: [], nextCursor: null }
    },
  })
  expect(await pullPortCatalogue(local, [space])).toEqual({
    count: 1,
    completedSpaces: new Set([space]),
  })
  expect(calls).toEqual([
    'port_doctrine',
    'port_doctrine',
    'port_pair',
    'port_baseline',
    'port_ref',
    'port_ref_source',
    'port_skip',
  ])

  const held = newRecordId()
  const heldCalls: string[] = []
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    async listPortCatalogue(table) {
      heldCalls.push(table)
      return table === 'port_baseline'
        ? {
            items: [
              {
                id: newRecordId(),
                spaceId: held,
                pairId: newRecordId(),
                sourceCommit: null,
                scannedAt: null,
                version: 1,
                updatedAt: at,
              },
            ],
            nextCursor: null,
          }
        : { items: [], nextCursor: null }
    },
  })
  expect(await pullPortCatalogue(local, [held])).toEqual({
    count: 0,
    completedSpaces: new Set(),
  })
  expect(heldCalls).toEqual(['port_doctrine', 'port_pair', 'port_baseline'])
  expect(
    local
      .query('SELECT value FROM schema_meta WHERE key=?')
      .get(`record_port_cursor:${held}:port_baseline`),
  ).toBeNull()
})

test('a hosted pull keeps the null-space local copy', () => {
  const local = db()
  const before = local
    .query<{ n: number }, []>('SELECT COUNT(*) n FROM port_doctrine WHERE space_id IS NULL')
    .get()!.n
  applyPortCatalogueRow(local, 'port_doctrine', doctrine(newRecordId()))
  expect(
    local
      .query<{ n: number }, []>('SELECT COUNT(*) n FROM port_doctrine WHERE space_id IS NULL')
      .get()!.n,
  ).toBe(before)
})

test('port pull caches unregistered catalogue rows and continues to a registered pair', async () => {
  const local = db()
  local.query('DELETE FROM project').run()
  const space = newRecordId()
  const unregisteredSource = newRecordId()
  const unregisteredTarget = newRecordId()
  const registeredSource = newRecordId()
  const registeredTarget = newRecordId()
  const unregisteredPair = newRecordId()
  const registeredPair = newRecordId()
  const ref = newRecordId()
  const source = newRecordId()
  const persisted = encodeRecordCursor({ at: '2026-10-18T00:00:00.000Z', id: newRecordId() })
  local
    .query('INSERT INTO schema_meta (key,value) VALUES (?,?)')
    .run(
      `record_port_cursor:${space}:port_pair`,
      JSON.stringify({ at: '2026-10-18T00:00:00.000Z', id: newRecordId() }),
    )
  let pairPage = 0
  let firstPairCursor: string | undefined
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    async listPortCatalogue(table, query) {
      if (table === 'port_pair') {
        pairPage++
        if (pairPage === 1) {
          firstPairCursor = query.cursor
          return {
            items: [
              {
                id: unregisteredPair,
                spaceId: space,
                sourceProjectId: unregisteredSource,
                targetProjectId: unregisteredTarget,
                createdAt: at,
              },
            ],
            nextCursor: persisted,
          }
        }
        upsertProject({
          recordId: registeredSource,
          name: 'later-source',
          path: '/tmp/later-source',
          settings: {},
        })
        upsertProject({
          recordId: registeredTarget,
          name: 'later-target',
          path: '/tmp/later-target',
          settings: {},
        })
        return {
          items: [
            {
              id: registeredPair,
              spaceId: space,
              sourceProjectId: registeredSource,
              targetProjectId: registeredTarget,
              createdAt: at,
            },
          ],
          nextCursor: null,
        }
      }
      if (table === 'port_ref')
        return {
          items: [
            {
              id: ref,
              spaceId: space,
              taskKey: 'DEV-1404',
              targetProjectId: unregisteredTarget,
              note: 'unregistered target',
              createdAt: at,
              resolvedAt: null,
              deletedAt: null,
              version: 1,
              updatedAt: at,
            },
          ],
          nextCursor: null,
        }
      if (table === 'port_ref_source')
        return {
          items: [
            {
              id: source,
              spaceId: space,
              refId: ref,
              sourceProjectId: unregisteredSource,
              commits: '[]',
              paths: '[]',
              note: 'unregistered source',
              deletedAt: null,
              updatedAt: at,
            },
          ],
          nextCursor: null,
        }
      return { items: [], nextCursor: null }
    },
  })

  expect(await pullPortCatalogue(local, [space])).toEqual({
    count: 4,
    completedSpaces: new Set([space]),
  })
  expect(firstPairCursor).toBeDefined()
  expect(
    local
      .query('SELECT 1 FROM port_pair WHERE record_id IN (?,?)')
      .all(unregisteredPair, registeredPair),
  ).toHaveLength(2)
  expect(
    local.query('SELECT target_project_record_id FROM port_ref WHERE record_id=?').get(ref),
  ).toEqual({ target_project_record_id: unregisteredTarget })
  expect(
    local
      .query('SELECT source_project_record_id FROM port_ref_source WHERE record_id=?')
      .get(source),
  ).toEqual({ source_project_record_id: unregisteredSource })
})

test('port tombstones remove only hosted refs and replaced sources', async () => {
  const local = db()
  const space = newRecordId()
  const sourceId = newRecordId()
  const targetId = newRecordId()
  upsertProject({ recordId: sourceId, name: 'tombstone-source', path: '/w/source', settings: {} })
  upsertProject({ recordId: targetId, name: 'tombstone-target', path: '/w/target', settings: {} })
  rememberProjectSpace(local, 'tombstone-target', space)
  const source = {
    source_project_record_id: sourceId,
    commits: ['local'],
    paths: ['local.ts'],
    note: 'local source',
  }
  for (const taskKey of ['DEV-DELETE', 'DEV-SOURCE'])
    setLedgerRefLocal({
      taskKey,
      targetProjectId: targetId,
      note: `local ${taskKey}`,
      sources: [source],
      createdAt: at,
    })

  const deleteRefId = newRecordId()
  const deleteSourceId = newRecordId()
  const sourceRefId = newRecordId()
  const replacedSourceId = newRecordId()
  const hostedRef = (id: string, taskKey: string) => ({
    id,
    spaceId: space,
    taskKey,
    targetProjectId: targetId,
    note: `hosted ${taskKey}`,
    createdAt: at,
    resolvedAt: null,
    deletedAt: null,
    version: 1,
    updatedAt: at,
  })
  const hostedSource = (id: string, refId: string) => ({
    id,
    spaceId: space,
    refId,
    sourceProjectId: sourceId,
    commits: '["hosted"]',
    paths: '["hosted.ts"]',
    note: 'hosted source',
    deletedAt: null,
    updatedAt: at,
  })
  applyPortCatalogueRow(local, 'port_ref', hostedRef(deleteRefId, 'DEV-DELETE'))
  applyPortCatalogueRow(local, 'port_ref_source', hostedSource(deleteSourceId, deleteRefId))
  applyPortCatalogueRow(local, 'port_ref', hostedRef(sourceRefId, 'DEV-SOURCE'))
  applyPortCatalogueRow(local, 'port_ref_source', hostedSource(replacedSourceId, sourceRefId))

  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    async listPortCatalogue(table) {
      if (table === 'port_ref')
        return {
          items: [
            {
              ...hostedRef(deleteRefId, 'DEV-DELETE'),
              deletedAt: '2026-10-18T12:01:00.000Z',
              version: 2,
              updatedAt: '2026-10-18T12:01:00.000Z',
            },
          ],
          nextCursor: null,
        }
      if (table === 'port_ref_source')
        return {
          items: [
            {
              ...hostedSource(replacedSourceId, sourceRefId),
              deletedAt: '2026-10-18T12:01:00.000Z',
              updatedAt: '2026-10-18T12:01:00.000Z',
            },
          ],
          nextCursor: null,
        }
      return { items: [], nextCursor: null }
    },
  })
  expect(await pullPortCatalogue(local, [space])).toEqual({
    count: 2,
    completedSpaces: new Set([space]),
  })

  expect(ledgerRef(targetId, 'DEV-DELETE')).toMatchObject({ note: 'local DEV-DELETE' })
  expect(ledgerRef(targetId, 'DEV-SOURCE')).toMatchObject({
    note: 'hosted DEV-SOURCE',
    sources: [],
  })
  expect(listLedgerRefs(true)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ task_key: 'DEV-DELETE', note: 'local DEV-DELETE' }),
      expect.objectContaining({ task_key: 'DEV-SOURCE', note: 'hosted DEV-SOURCE', sources: [] }),
    ]),
  )
  expect(
    local.query('SELECT 1 FROM port_ref WHERE record_id=? AND space_id=?').get(deleteRefId, space),
  ).toBeNull()
  expect(
    local
      .query('SELECT 1 FROM port_ref_source WHERE record_id=? AND space_id=?')
      .get(replacedSourceId, space),
  ).toBeNull()
  expect(
    local.query<{ n: number }, []>('SELECT COUNT(*) n FROM port_ref WHERE space_id IS NULL').get()!
      .n,
  ).toBe(2)
  expect(
    local
      .query<{ n: number }, []>('SELECT COUNT(*) n FROM port_ref_source WHERE space_id IS NULL')
      .get()!.n,
  ).toBe(2)
})

test('project routing is not published while a port stream is held', async () => {
  const local = db()
  const oldSpace = newRecordId()
  const newSpace = newRecordId()
  const project = 'port-moving-project'
  upsertProject({
    recordId: newRecordId(),
    name: project,
    path: `/tmp/${project}`,
    settings: { space: 'new-space' },
  })
  rememberProjectSpace(local, project, oldSpace)
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
    listPortCatalogue: async (table, _query, destination) => ({
      items:
        destination?.destinationSpaceId === newSpace && table === 'port_baseline'
          ? [
              {
                id: newRecordId(),
                spaceId: newSpace,
                pairId: newRecordId(),
                sourceCommit: null,
                scannedAt: null,
                version: 1,
                updatedAt: at,
              },
            ]
          : [],
      nextCursor: null,
    }),
  })
  await pullRecordCache(local)
  expect(effectiveProjectSpace(local, project)).toBe(oldSpace)
})
