import { afterEach, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { resolveLens, selectProjectProfile, setProfile } from '../lens/lenses.ts'
import {
  addPairLocal,
  ledgerRef,
  pairByProjects,
  setBaselineLocal,
  setLedgerRefLocal,
} from '../porting/porting.ts'
import { upsertProject } from '../project/projects.ts'
import { rememberActiveRecordSpace, rememberProjectSpace } from '../project-space.ts'
import { productionWorkflowTree } from '../workflow/workflow-tree-store.ts'
import type { RecordApiClient, RecordRequestDestination } from './record-api-client.ts'
import type { RecordLensImportInput, RecordLensTable } from './record-lens-contract.ts'
import type { RecordPortImportInput, RecordPortTable } from './record-port-contract.ts'
import { pushCataloguesCommand } from './record-push-catalogues.ts'
import type { RecordWorkflowImportInput, RecordWorkflowTable } from './record-workflow-contract.ts'

const spaceId = newRecordId()
type WorkflowOutcome = {
  kind: 'workflow' | 'step_catalogue'
  slug: string
  outcome: 'replaced seeded built-in' | 'kept hosted history; local history not imported'
}

function fakeCatalogueClient(
  memberships = [
    {
      space_id: spaceId,
      slug: 'active',
      name: 'Active',
      role: 'owner',
      permission: 'write',
    },
  ],
  observeLens: (input: RecordLensImportInput, spaceId: string) => void = () => undefined,
  workflowOutcomes: WorkflowOutcome[] | ((spaceId: string) => WorkflowOutcome[]) = [],
  observePort: (input: RecordPortImportInput, spaceId: string) => void = () => undefined,
  observeWorkflow: (input: RecordWorkflowImportInput, spaceId: string) => void = () => undefined,
): RecordApiClient {
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
        const existing = held.find((row) => row.id === value.id)
        if (existing?.spaceId === space) alreadyPresent++
        else if (existing) throw new Error(`duplicate global id ${String(value.id)}`)
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
      memberships,
    }),
    sync: async (request) => ({
      results: request.rows.map((row) => ({
        id: row.id,
        status: 'synced' as const,
      })),
    }),
    ensureSpaceBuiltIns: async () => ({ inserted: 0, alreadyPresent: 0 }),
    importLensCatalogue: async (input: RecordLensImportInput, target) => {
      const space = destination(target)
      observeLens(input, space)
      return insert(lens, input as unknown as Record<string, unknown>, space)
    },
    importWorkflowCatalogue: async (input: RecordWorkflowImportInput, target) => {
      const space = destination(target)
      observeWorkflow(input, space)
      return {
        ...insert(workflow, input as unknown as Record<string, unknown>, space),
        outcomes:
          typeof workflowOutcomes === 'function' ? workflowOutcomes(space) : workflowOutcomes,
      }
    },
    importPortCatalogue: async (input: RecordPortImportInput, target) => {
      const space = destination(target)
      observePort(input, space)
      return insert(port, input as unknown as Record<string, Record<string, unknown>[]>, space)
    },
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

test('dry run logs its local plan without calling hosted methods', async () => {
  const local = db(),
    projectId = newRecordId()
  upsertProject({
    recordId: projectId,
    name: `dry-run-${projectId}`,
    path: `/tmp/dry-run-${projectId}`,
    settings: {},
  })
  rememberActiveRecordSpace(local, spaceId)
  rememberProjectSpace(local, `dry-run-${projectId}`, spaceId)
  const logs: string[] = []
  const throwingClient = new Proxy({} as RecordApiClient, {
    get: (_target, property) => {
      throw new Error(`hosted method ${String(property)} must not be read during dry run`)
    },
  })
  await pushCataloguesCommand(
    { dryRun: true },
    { log: (line) => logs.push(line) },
    { local, client: throwingClient },
  )
  expect(logs).toContainEqual(
    expect.stringMatching(
      new RegExp(`^dry run space ${spaceId} — lens: \\d+; workflow: \\d+; port: \\d+$`),
    ),
  )
})

test('a bound store with no local lens or port rows reports nothing to push without importing', async () => {
  const local = db()
  local.exec(`
    DELETE FROM project_lens_profile_revision WHERE space_id IS NULL;
    DELETE FROM project_lens_profile WHERE space_id IS NULL;
    DELETE FROM lens_profile_revision WHERE space_id IS NULL;
    DELETE FROM lens_profile WHERE space_id IS NULL;
    DELETE FROM lens_revision WHERE space_id IS NULL;
    DELETE FROM lens WHERE space_id IS NULL;
    DELETE FROM port_ref_source WHERE space_id IS NULL;
    DELETE FROM port_ref WHERE space_id IS NULL;
    DELETE FROM port_skip WHERE space_id IS NULL;
    DELETE FROM port_baseline WHERE space_id IS NULL;
    DELETE FROM port_pair WHERE space_id IS NULL;
    DELETE FROM port_doctrine WHERE space_id IS NULL;
    DELETE FROM project;
    INSERT OR REPLACE INTO record_install_binding(id,bound_at) VALUES (1,'2026-10-20T00:00:00.000Z');
  `)
  const logs: string[] = []
  let imports = 0
  const client = fakeCatalogueClient()
  client.importLensCatalogue = async () => {
    imports++
    throw new Error('lens import must not be called')
  }
  client.importWorkflowCatalogue = async () => {
    imports++
    throw new Error('workflow import must not be called')
  }
  client.importPortCatalogue = async () => {
    imports++
    throw new Error('port import must not be called')
  }

  await pushCataloguesCommand(
    { dryRun: false },
    { log: (line) => logs.push(line) },
    { local, client, sync: async () => undefined },
  )

  expect(logs).toContain('nothing to push for lens and port catalogues')
  expect(imports).toBe(0)
})

test('pushes complete workflow history to every registered project space and lists both in dry run', async () => {
  const local = db(),
    remoteSpace = newRecordId(),
    activeProjectId = newRecordId(),
    remoteProjectId = newRecordId(),
    activeProject = `workflow-active-${activeProjectId}`,
    remoteProject = `workflow-remote-${remoteProjectId}`
  upsertProject({
    recordId: activeProjectId,
    name: activeProject,
    path: `/tmp/${activeProject}`,
    settings: { space: 'active' },
  })
  upsertProject({
    recordId: remoteProjectId,
    name: remoteProject,
    path: `/tmp/${remoteProject}`,
    settings: { space: 'remote' },
  })
  rememberActiveRecordSpace(local, spaceId)
  rememberProjectSpace(local, activeProject, spaceId)
  rememberProjectSpace(local, remoteProject, remoteSpace)
  const imports = new Map<string, RecordWorkflowImportInput>()
  const logs: string[] = []
  const client = fakeCatalogueClient(
    [
      { space_id: spaceId, slug: 'active', name: 'Active', role: 'owner', permission: 'write' },
      {
        space_id: remoteSpace,
        slug: 'remote',
        name: 'Remote',
        role: 'owner',
        permission: 'write',
      },
    ],
    undefined,
    (destination) => [
      {
        kind: 'workflow',
        slug: 'fix-defect',
        outcome:
          destination === spaceId
            ? 'kept hosted history; local history not imported'
            : 'replaced seeded built-in',
      },
    ],
    undefined,
    (input, destination) => imports.set(destination, input),
  )
  installRecordApiClient(client)

  await pushCataloguesCommand(
    { dryRun: false },
    { log: (line) => logs.push(line) },
    { local, client },
  )

  expect([...imports.keys()]).toEqual([spaceId, remoteSpace])
  const activeInput = imports.get(spaceId)!
  for (const [destination, input] of imports) {
    expect(input.workflow.filter((row) => row.slug === 'fix-defect')).toEqual([
      expect.objectContaining({ spaceId: destination }),
    ])
    expect(input.workflow_version.every((row) => row.spaceId === destination)).toBeTrue()
    expect(input.workflow_event.every((row) => row.spaceId === destination)).toBeTrue()
    expect(input.step_catalogue.every((row) => row.spaceId === destination)).toBeTrue()
    for (const kind of ['workflow', 'step_catalogue'] as const) {
      const identityIds = new Set(input[kind].map((row) => row.id))
      const versionIds = new Set(input[`${kind}_version`].map((row) => row.id))
      expect(input[`${kind}_version`].every((row) => identityIds.has(row.ownerId))).toBeTrue()
      expect(input[`${kind}_event`].every((row) => versionIds.has(row.ownerVersionId))).toBeTrue()
    }
  }
  const remoteInput = imports.get(remoteSpace)!
  for (const table of [
    'workflow',
    'workflow_version',
    'workflow_event',
    'step_catalogue',
    'step_catalogue_version',
    'step_catalogue_event',
  ] as const)
    expect(
      remoteInput[table].every(
        (row) => !new Set(activeInput[table].map((active) => active.id)).has(row.id),
      ),
    ).toBeTrue()
  expect(logs).toContain(
    `workflow ${spaceId} workflow fix-defect: kept hosted history; local history not imported`,
  )
  expect(logs).toContain(`workflow ${remoteSpace} workflow fix-defect: replaced seeded built-in`)

  logs.length = 0
  await pushCataloguesCommand({ dryRun: true }, { log: (line) => logs.push(line) }, { local })
  for (const destination of [spaceId, remoteSpace])
    expect(logs).toContainEqual(
      expect.stringMatching(
        new RegExp(`^dry run space ${destination} — lens: \\d+; workflow: \\d+; port: \\d+$`),
      ),
    )
})

test('push and cache reconciliation normalizes a date-only baseline', async () => {
  const local = db(),
    sourceId = newRecordId(),
    targetId = newRecordId()
  upsertProject({
    recordId: sourceId,
    name: 'dated-source',
    path: '/tmp/dated-source',
    settings: {},
  })
  upsertProject({
    recordId: targetId,
    name: 'dated-target',
    path: '/tmp/dated-target',
    settings: {},
  })
  rememberProjectSpace(local, 'dated-source', spaceId)
  rememberProjectSpace(local, 'dated-target', spaceId)
  const pair = addPairLocal(sourceId, targetId)
  setBaselineLocal(pair.record_id, 'abc123', '2026-08-24')
  const imports: RecordPortImportInput[] = []
  const client = fakeCatalogueClient(undefined, undefined, [], (input) => imports.push(input))
  installRecordApiClient(client)

  await pushCataloguesCommand({ dryRun: false }, { log: () => undefined }, { local, client })

  expect(imports.flatMap((input) => input.port_baseline)).toEqual([
    expect.objectContaining({ scannedAt: '2026-08-24T00:00:00.000Z' }),
  ])
  expect(
    local.query('SELECT scanned_at FROM port_baseline WHERE pair_record_id=?').get(pair.record_id),
  ).toEqual({ scanned_at: '2026-08-24T00:00:00.000Z' })
})

test('prints workflow import reconciliation outcomes', async () => {
  const local = db(),
    projectId = newRecordId(),
    projectName = `workflow-outcome-${projectId}`,
    logs: string[] = [],
    client = fakeCatalogueClient(undefined, undefined, [
      { kind: 'workflow', slug: 'fix-defect', outcome: 'replaced seeded built-in' },
      {
        kind: 'step_catalogue',
        slug: 'shared',
        outcome: 'kept hosted history; local history not imported',
      },
    ])
  upsertProject({
    recordId: projectId,
    name: projectName,
    path: `/tmp/${projectName}`,
    settings: {},
  })
  rememberActiveRecordSpace(local, spaceId)
  rememberProjectSpace(local, projectName, spaceId)
  installRecordApiClient(client)
  await pushCataloguesCommand(
    { dryRun: false },
    { log: (line) => logs.push(line) },
    { local, client },
  )
  expect(logs).toContain(`workflow ${spaceId} workflow fix-defect: replaced seeded built-in`)
  expect(logs).toContain(
    `workflow ${spaceId} step_catalogue shared: kept hosted history; local history not imported`,
  )
})

test('dry run names an uncached project route as unknown', async () => {
  const local = db(),
    sourceId = newRecordId(),
    targetId = newRecordId()
  upsertProject({ recordId: sourceId, name: 'uncached-source', path: '/tmp/source', settings: {} })
  upsertProject({ recordId: targetId, name: 'uncached-target', path: '/tmp/target', settings: {} })
  addPairLocal(sourceId, targetId)
  rememberActiveRecordSpace(local, spaceId)
  const logs: string[] = []
  await pushCataloguesCommand({ dryRun: true }, { log: (line) => logs.push(line) }, { local })
  expect(logs).toContainEqual(
    expect.stringContaining(`source project route unknown, run \`${PLATFORM_SLUG} record sync\``),
  )
  expect(logs.some((line) => line.includes('source project has no hosted space'))).toBeFalse()
})

test('push and sync expose cross-space pairs, refs, and sources from the target space', async () => {
  const local = db(),
    sourceId = newRecordId(),
    targetId = newRecordId(),
    sourceSpace = newRecordId(),
    sourceName = `catalogue-ref-source-${sourceId}`,
    targetName = `catalogue-ref-target-${targetId}`
  upsertProject({
    recordId: sourceId,
    name: sourceName,
    path: `/tmp/${sourceName}`,
    settings: { space: 'source' },
  })
  upsertProject({
    recordId: targetId,
    name: targetName,
    path: `/tmp/${targetName}`,
    settings: { space: 'active' },
  })
  addPairLocal(sourceId, targetId)
  const taskKey = `REF-${sourceId.slice(0, 6)}`
  setLedgerRefLocal({
    taskKey,
    targetProjectId: targetId,
    note: 'cross-space',
    sources: [{ source_project_record_id: sourceId, commits: [], paths: [], note: '' }],
  })
  const client = fakeCatalogueClient([
    {
      space_id: spaceId,
      slug: 'active',
      name: 'Active',
      role: 'owner',
      permission: 'write',
    },
    {
      space_id: sourceSpace,
      slug: 'source',
      name: 'Source',
      role: 'owner',
      permission: 'write',
    },
  ])
  installRecordApiClient(client)
  await pushCataloguesCommand({ dryRun: false }, { log: () => undefined }, { local, client })

  expect(pairByProjects(sourceId, targetId)).not.toBeNull()
  expect(ledgerRef(targetId, taskKey)?.sources).toEqual([
    expect.objectContaining({ source_project_record_id: sourceId }),
  ])
  expect(
    local
      .query('SELECT 1 FROM port_pair WHERE space_id=? AND source_project_record_id=?')
      .get(spaceId, sourceId),
  ).not.toBeNull()
  expect(
    local
      .query('SELECT 1 FROM port_ref WHERE space_id=? AND target_project_record_id=?')
      .get(spaceId, targetId),
  ).not.toBeNull()
  expect(
    local
      .query('SELECT 1 FROM port_ref_source WHERE space_id=? AND source_project_record_id=?')
      .get(spaceId, sourceId),
  ).not.toBeNull()
})

test('push and sync resolves a non-active project lens from its routed space', async () => {
  const local = db(),
    remoteSpace = newRecordId(),
    projectId = newRecordId(),
    projectName = `catalogue-remote-${projectId}`
  upsertProject({
    recordId: projectId,
    name: projectName,
    path: `/tmp/${projectName}`,
    settings: { space: 'remote' },
  })
  rememberActiveRecordSpace(local, spaceId)
  await setProfile({
    lensId: 'correctness',
    axis: 'framework',
    name: 'project-body',
    body: '{"framework_guidance":"project","commands":"none"}',
    enabled: true,
    reason: 'project body fixture',
  })
  await selectProjectProfile({
    project: projectName,
    lensId: 'correctness',
    axis: 'framework',
    name: 'project-body',
    reason: 'project selection fixture',
  })
  rememberProjectSpace(local, projectName, remoteSpace)
  const remoteImports: RecordLensImportInput[] = []
  const client = fakeCatalogueClient(
    [
      {
        space_id: spaceId,
        slug: 'active',
        name: 'Active',
        role: 'owner',
        permission: 'write',
      },
      {
        space_id: remoteSpace,
        slug: 'remote',
        name: 'Remote',
        role: 'owner',
        permission: 'write',
      },
    ],
    (input, destination) => {
      if (destination === remoteSpace) remoteImports.push(input)
    },
  )
  installRecordApiClient(client)
  await pushCataloguesCommand({ dryRun: false }, { log: () => undefined }, { local, client })
  expect(remoteImports[0]!.project_lens_profile).toHaveLength(1)
  expect(resolveLens('correctness', projectName, local)).toMatchObject({
    body: expect.stringContaining('FRAMEWORK GUIDANCE\nproject'),
    profiles: [expect.objectContaining({ name: 'project-body', source: 'project' })],
  })
  expect(
    local
      .query(
        `SELECT 1 FROM project_lens_profile
         WHERE project_record_id=? AND space_id=? AND profile_name='project-body'`,
      )
      .get(projectId, remoteSpace),
  ).not.toBeNull()
})

test('push includes a retired project lens selection in its declared space', async () => {
  const local = db(),
    remoteSpace = newRecordId(),
    projectId = newRecordId(),
    projectName = `catalogue-retired-${projectId}`
  upsertProject({
    recordId: projectId,
    name: projectName,
    path: `/tmp/${projectName}`,
    settings: { space: 'remote' },
  })
  await selectProjectProfile({
    project: projectName,
    lensId: 'correctness',
    axis: 'framework',
    name: 'default',
    reason: 'retired selection fixture',
  })
  local
    .query('UPDATE project SET retired_at=? WHERE record_id=?')
    .run(new Date().toISOString(), projectId)
  const remoteImports: RecordLensImportInput[] = []
  const client = fakeCatalogueClient(
    [
      { space_id: spaceId, slug: 'active', name: 'Active', role: 'owner', permission: 'write' },
      { space_id: remoteSpace, slug: 'remote', name: 'Remote', role: 'owner', permission: 'write' },
    ],
    (input, destination) => {
      if (destination === remoteSpace) remoteImports.push(input)
    },
  )
  installRecordApiClient(client)
  await pushCataloguesCommand({ dryRun: false }, { log: () => undefined }, { local, client })
  expect(remoteImports[0]!.project_lens_profile).toEqual([
    expect.objectContaining({ projectId, profileName: 'default' }),
  ])
})
