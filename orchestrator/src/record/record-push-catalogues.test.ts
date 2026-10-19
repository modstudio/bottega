import { afterEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { resolveLens } from '../lens/lenses.ts'
import { addPairLocal, pairByProjects } from '../porting/porting.ts'
import { upsertProject } from '../project/projects.ts'
import { rememberProjectSpace } from '../project-space.ts'
import { productionWorkflowTree } from '../workflow/workflow-tree-store.ts'
import type { RecordApiClient, RecordRequestDestination } from './record-api-client.ts'
import type { RecordLensImportInput, RecordLensTable } from './record-lens-contract.ts'
import type { RecordPortImportInput, RecordPortTable } from './record-port-contract.ts'
import { pushCataloguesCommand } from './record-push-catalogues.ts'
import type { RecordWorkflowImportInput, RecordWorkflowTable } from './record-workflow-contract.ts'

const spaceId = newRecordId()

function fakeCatalogueClient(): RecordApiClient {
  const base = createMemoryRecordApiClient()
  const lens = new Map<RecordLensTable, Record<string, unknown>[]>()
  const workflow = new Map<RecordWorkflowTable, Record<string, unknown>[]>()
  const port = new Map<RecordPortTable, Record<string, unknown>[]>()
  const destination = (value?: RecordRequestDestination) => value?.destinationSpaceId ?? spaceId
  const insert = <T extends Record<string, unknown>>(
    store: Map<string, T[]>,
    input: Record<string, unknown>,
    space: string,
  ) => {
    let inserted = 0,
      alreadyPresent = 0
    for (const [table, values] of Object.entries(input)) {
      if (!Array.isArray(values)) continue
      const held = store.get(table) ?? []
      for (const value of values as T[]) {
        if (held.some((row) => row.id === value.id && row.spaceId === space)) alreadyPresent++
        else {
          held.push({ ...value, spaceId: space })
          inserted++
        }
      }
      store.set(table, held)
    }
    return { inserted, alreadyPresent, skipped: [] }
  }
  return {
    ...base,
    whoami: async () => ({
      user: { id: newRecordId() },
      activeSpaceId: spaceId,
      personalSpaceId: null,
      memberships: [
        { space_id: spaceId, slug: 'active', name: 'Active', role: 'owner', permission: 'write' },
      ],
    }),
    sync: async (request) => ({
      results: request.rows.map((row) => ({ id: row.id, status: 'synced' as const })),
    }),
    ensureSpaceBuiltIns: async () => ({ inserted: 0, alreadyPresent: 0 }),
    importLensCatalogue: async (input: RecordLensImportInput, target) =>
      insert(lens, input as unknown as Record<string, unknown>, destination(target)),
    importWorkflowCatalogue: async (input: RecordWorkflowImportInput, target) =>
      insert(workflow, input as unknown as Record<string, unknown>, destination(target)),
    importPortCatalogue: async (input: RecordPortImportInput, target) =>
      insert(
        port,
        input as unknown as Record<string, Record<string, unknown>[]>,
        destination(target),
      ),
    listLensCatalogue: async (table, _query, target) => ({
      items: (lens.get(table) ?? []).filter((row) => row.spaceId === destination(target)),
      nextCursor: null,
    }),
    listWorkflowCatalogue: async (table, _query, target) => ({
      items: (workflow.get(table) ?? []).filter((row) => row.spaceId === destination(target)),
      nextCursor: null,
    }),
    listPortCatalogue: async (table, _query, target) => ({
      items: (port.get(table) ?? []).filter(
        (row) => row.spaceId === destination(target),
      ) as never[],
      nextCursor: null,
    }),
  }
}

afterEach(() => installRecordApiClient(null))

test('pushes a seeded local store through bulk routes and sync resolves routed catalogues', async () => {
  const local = db(),
    sourceId = newRecordId(),
    targetId = newRecordId()
  upsertProject({
    recordId: sourceId,
    name: 'catalogue-source',
    path: '/tmp/source',
    settings: { space: 'active' },
  })
  upsertProject({
    recordId: targetId,
    name: 'catalogue-target',
    path: '/tmp/target',
    settings: { space: 'active' },
  })
  rememberProjectSpace(local, 'catalogue-source', spaceId)
  rememberProjectSpace(local, 'catalogue-target', spaceId)
  addPairLocal(sourceId, targetId)
  const client = fakeCatalogueClient()
  installRecordApiClient(client)
  await pushCataloguesCommand({ dryRun: false }, { log: () => undefined }, { local, client })
  expect(resolveLens('correctness', 'catalogue-target', local)?.title).toBe('Correctness')
  expect(
    local.query("SELECT 1 FROM lens WHERE id='correctness' AND space_id=?").get(spaceId),
  ).not.toBeNull()
  expect(
    productionWorkflowTree(local, 'catalogue-target').workflows.some(
      (row) => row.slug === 'fix-defect',
    ),
  ).toBeTrue()
  expect(pairByProjects(sourceId, targetId)).not.toBeNull()
  expect(local.query('SELECT 1 FROM port_pair WHERE space_id=?').get(spaceId)).not.toBeNull()
})
