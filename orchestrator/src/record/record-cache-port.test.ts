import { afterEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { effectiveProjectSpace, rememberProjectSpace } from '../project-space.ts'
import { pullRecordCache } from './record-cache.ts'
import { applyPortCatalogueRow, pullPortCatalogue } from './record-cache-port.ts'

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
