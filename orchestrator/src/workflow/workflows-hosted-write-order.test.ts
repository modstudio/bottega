import { afterEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { applyWorkflowCatalogueRow } from '../record/record-cache-workflow.ts'
import type { RecordWorkflowWriteResponse } from '../record/record-workflow-contract.ts'
import { productionStepCatalogue } from './step-catalogue.ts'
import { BUILT_IN_WORKFLOW_AUTHOR } from './workflow-built-ins.ts'
import {
  importWorkflow,
  productionWorkflows,
  promoteWorkflow,
  promoteWorkflowLocal,
  setWorkflow,
  setWorkflowLocal,
  type WorkflowDefinition,
} from './workflows.ts'

const SPACE = '01990000-0000-7000-8000-000000000222'
const at = '2026-10-18T12:00:00.000Z'
const whoami = async () => ({
  user: { id: newRecordId() },
  activeSpaceId: SPACE,
  personalSpaceId: SPACE,
  memberships: [],
})
function installHostedCatalogue(): (table: string) => Record<string, unknown>[] {
  const local = db(),
    ownerId = newRecordId(),
    versionId = newRecordId()
  const identity = {
    id: ownerId,
    spaceId: SPACE,
    slug: 'shared',
    generation: 1,
    createdAt: at,
    updatedAt: at,
  }
  const version = {
    id: versionId,
    spaceId: SPACE,
    ownerId,
    n: 1,
    status: 'production',
    definition: JSON.stringify(productionStepCatalogue(local).definition),
    author: 'test',
    reason: 'test',
    createdAt: at,
    promotedAt: at,
    retiredAt: null,
    updatedAt: at,
  }
  applyWorkflowCatalogueRow(local, 'step_catalogue', identity)
  applyWorkflowCatalogueRow(local, 'step_catalogue_version', version)
  return (table) => {
    if (table === 'step_catalogue') return [identity]
    if (table === 'step_catalogue_version') return [version]
    return []
  }
}
afterEach(() => {
  delete process.env.ORCH_RECORD_API_URL
  installRecordApiClient(createMemoryRecordApiClient())
})

test('hosted import validates a workflow against a same-import catalogue', async () => {
  installHostedCatalogue()
  const local = db()
  const productionCatalogue = productionStepCatalogue(local).definition
  const sourceStep = productionCatalogue.steps[0]!
  const knownCatalogue = {
    ...productionCatalogue,
    steps: [...productionCatalogue.steps, { ...sourceStep, slug: 'same-import-step' }],
  }
  const definition = structuredClone(productionWorkflows(local, null)[0]!.definition)
  definition.modes[0]!.steps = ['same-import-step']
  process.env.ORCH_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami,
    async draftWorkflow() {
      throw new Error('reached hosted draft')
    },
  })

  await expect(
    importWorkflow('same-import-flow', definition, 'same import', 'test', local, knownCatalogue),
  ).rejects.toThrow('reached hosted draft')
})

test('hosted set failure is inert and success adopts identity, version, and event ids', async () => {
  installHostedCatalogue()
  const definition = { ...productionWorkflows(db(), null)[0]!.definition, title: 'Hosted set' }
  process.env.ORCH_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami,
    async draftWorkflow() {
      throw new Error('hosted set failed')
    },
  })
  await expect(setWorkflow('hosted-order', definition, 'set')).rejects.toThrow('hosted set failed')
  expect(db().query("SELECT COUNT(*) n FROM workflow WHERE slug='hosted-order'").get()).toEqual({
    n: 0,
  })

  const ownerId = newRecordId(),
    versionId = newRecordId(),
    eventId = newRecordId()
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami,
    async draftWorkflow() {
      return {
        identity: {
          id: ownerId,
          spaceId: SPACE,
          slug: 'hosted-order',
          generation: 1,
          createdAt: at,
          updatedAt: at,
        },
        versions: [
          {
            id: versionId,
            spaceId: SPACE,
            ownerId,
            n: 1,
            status: 'draft',
            definition: JSON.stringify(definition),
            author: 'unknown',
            reason: 'set',
            createdAt: at,
            promotedAt: null,
            retiredAt: null,
            updatedAt: at,
          },
        ],
        events: [
          {
            id: eventId,
            spaceId: SPACE,
            ownerVersionId: versionId,
            event: 'set',
            author: 'unknown',
            reason: 'set',
            sessionId: null,
            at,
          },
        ],
      }
    },
  })
  expect((await setWorkflow('hosted-order', definition, 'set')).n).toBe(1)
  expect(db().query('SELECT record_id FROM workflow WHERE space_id=?').get(SPACE)).toEqual({
    record_id: ownerId,
  })
  expect(db().query('SELECT record_id FROM workflow_version WHERE space_id=?').get(SPACE)).toEqual({
    record_id: versionId,
  })
  expect(db().query('SELECT record_id FROM workflow_event WHERE space_id=?').get(SPACE)).toEqual({
    record_id: eventId,
  })
})

test('hosted promote failure leaves draft state and success adopts promoted status and event id', async () => {
  const hostedCatalogueItems = installHostedCatalogue()
  const local = db(),
    definition = productionWorkflows(local, null)[0]!.definition
  const ownerId = newRecordId(),
    versionId = newRecordId(),
    setEventId = newRecordId()
  const identity = {
      id: ownerId,
      spaceId: SPACE,
      slug: 'hosted-promote',
      generation: 1,
      createdAt: at,
      updatedAt: at,
    },
    draftVersion = {
      id: versionId,
      spaceId: SPACE,
      ownerId,
      n: 1,
      status: 'draft' as const,
      definition: JSON.stringify(definition),
      author: 'unknown',
      reason: 'set',
      createdAt: at,
      promotedAt: null,
      retiredAt: null,
      updatedAt: at,
    },
    setEvent = {
      id: setEventId,
      spaceId: SPACE,
      ownerVersionId: versionId,
      event: 'set' as const,
      author: 'unknown',
      reason: 'set',
      sessionId: null,
      at,
      updatedAt: at,
    }
  const catalogueItems = (table: string) => {
    if (table === 'workflow') return [identity]
    if (table === 'workflow_version') return [draftVersion]
    if (table === 'workflow_event') return [setEvent]
    return hostedCatalogueItems(table)
  }
  process.env.ORCH_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami,
    async listWorkflowCatalogue(table) {
      return { items: catalogueItems(table), nextCursor: null }
    },
    async draftWorkflow() {
      return {
        identity,
        versions: [draftVersion],
        events: [setEvent],
      }
    },
    async promoteWorkflow() {
      throw new Error('hosted promote failed')
    },
  })
  await setWorkflow('hosted-promote', definition, 'set')
  await expect(promoteWorkflow('hosted-promote', 1, 'promote')).rejects.toThrow(
    'hosted promote failed',
  )
  expect(
    local.query('SELECT status FROM workflow_version WHERE record_id=?').get(versionId),
  ).toEqual({ status: 'draft' })

  const promoteEventId = newRecordId()
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami,
    async listWorkflowCatalogue(table) {
      return { items: catalogueItems(table), nextCursor: null }
    },
    async promoteWorkflow() {
      return {
        identity,
        versions: [
          {
            id: versionId,
            spaceId: SPACE,
            ownerId,
            n: 1,
            status: 'production',
            definition: JSON.stringify(definition),
            author: 'unknown',
            reason: 'set',
            createdAt: at,
            promotedAt: at,
            retiredAt: null,
            updatedAt: at,
          },
        ],
        events: [
          {
            id: promoteEventId,
            spaceId: SPACE,
            ownerVersionId: versionId,
            event: 'promote',
            author: 'unknown',
            reason: 'promote',
            sessionId: null,
            at,
          },
        ],
      }
    },
  })
  expect(await promoteWorkflow('hosted-promote', 1, 'promote')).toEqual({
    version: 1,
    changedSpaces: [SPACE],
    overrideSpaces: [],
    pinnedSpaces: [],
  })
  expect(
    local.query('SELECT status FROM workflow_version WHERE record_id=?').get(versionId),
  ).toEqual({ status: 'production' })
  expect(
    local.query('SELECT record_id FROM workflow_event WHERE record_id=?').get(promoteEventId),
  ).toEqual({ record_id: promoteEventId })
})

const FOLLOWER_SPACE = '01990000-0000-7000-8000-000000000333'
const SECOND_FOLLOWER_SPACE = '01990000-0000-7000-8000-000000000444'
type SharedFixtureSpace = {
  identity: RecordWorkflowWriteResponse['identity']
  versions: RecordWorkflowWriteResponse['versions']
  events: (RecordWorkflowWriteResponse['events'][number] & { updatedAt: string })[]
  catalogueIdentity: RecordWorkflowWriteResponse['identity']
  catalogueVersions: RecordWorkflowWriteResponse['versions']
}

function addSharedFixtureSpace(
  local: ReturnType<typeof db>,
  state: Map<string, SharedFixtureSpace>,
  slug: string,
  definition: WorkflowDefinition,
  spaceId: string,
  productionVersion: number,
  latestVersion: number,
  pinned: boolean,
  versionAuthor = BUILT_IN_WORKFLOW_AUTHOR,
  distinctDefinitions = false,
): void {
  const ownerId = newRecordId()
  const identity: RecordWorkflowWriteResponse['identity'] = {
    id: ownerId,
    spaceId,
    slug,
    generation: 1,
    createdAt: at,
    updatedAt: at,
  }
  const versions: RecordWorkflowWriteResponse['versions'] = Array.from(
    { length: latestVersion },
    (_, index) => {
      const n = index + 1
      return {
        id: newRecordId(),
        spaceId,
        ownerId,
        n,
        status:
          n === productionVersion
            ? ('production' as const)
            : n < productionVersion || pinned
              ? ('retired' as const)
              : ('draft' as const),
        definition: JSON.stringify(
          distinctDefinitions ? { ...definition, title: `${definition.title} v${n}` } : definition,
        ),
        author: versionAuthor,
        reason: n === 1 ? 'seed one' : n === 2 ? 'seed two' : `version ${n}`,
        createdAt: at,
        promotedAt: n <= productionVersion || pinned ? at : null,
        retiredAt: n < productionVersion || (pinned && n > productionVersion) ? at : null,
        updatedAt: at,
      }
    },
  )
  const productionId = versions.find((version) => version.n === productionVersion)!.id
  const events: SharedFixtureSpace['events'] = [
    {
      id: newRecordId(),
      spaceId,
      ownerVersionId: productionId,
      event: 'promote',
      author: versionAuthor,
      reason: pinned ? 'pin version one' : 'seed one',
      sessionId: null,
      at,
      updatedAt: at,
    },
  ]
  applyWorkflowCatalogueRow(local, 'workflow', identity)
  for (const version of versions) applyWorkflowCatalogueRow(local, 'workflow_version', version)
  for (const event of events) applyWorkflowCatalogueRow(local, 'workflow_event', event)
  const catalogueOwner = newRecordId()
  const catalogueIdentity = {
    id: catalogueOwner,
    spaceId,
    slug: 'shared',
    generation: 1,
    createdAt: at,
    updatedAt: at,
  }
  const catalogueVersions: RecordWorkflowWriteResponse['versions'] = [
    {
      id: newRecordId(),
      spaceId,
      ownerId: catalogueOwner,
      n: 1,
      status: 'production',
      definition: JSON.stringify(productionStepCatalogue(local).definition),
      author: 'test',
      reason: 'test',
      createdAt: at,
      promotedAt: at,
      retiredAt: null,
      updatedAt: at,
    },
  ]
  state.set(spaceId, { identity, versions, events, catalogueIdentity, catalogueVersions })
  applyWorkflowCatalogueRow(local, 'step_catalogue', catalogueIdentity)
  applyWorkflowCatalogueRow(local, 'step_catalogue_version', catalogueVersions[0]!)
}

function sharedFixtureItems(table: string, current: SharedFixtureSpace): Record<string, unknown>[] {
  if (table === 'step_catalogue') return [current.catalogueIdentity]
  if (table === 'step_catalogue_version') return current.catalogueVersions
  if (table === 'workflow') return [current.identity]
  if (table === 'workflow_version') return current.versions
  if (table === 'workflow_event') return current.events
  return []
}

function installSharedPromotionFixture(
  options: {
    catalogueAdvance?: boolean
    currentProduction?: boolean
    pinned?: boolean
    secondFollower?: boolean
    unreadable?: boolean
  } = {},
) {
  const local = db()
  const slug = 'shared-hosted'
  const definition = structuredClone(productionWorkflows(local, null)[0]!.definition)
  setWorkflowLocal(slug, definition, 'seed one', BUILT_IN_WORKFLOW_AUTHOR, local)
  promoteWorkflowLocal(
    slug,
    1,
    'seed one',
    options.currentProduction ? 'operator' : BUILT_IN_WORKFLOW_AUTHOR,
    local,
  )
  if (options.currentProduction)
    setWorkflowLocal(slug, definition, 'seed two', BUILT_IN_WORKFLOW_AUTHOR, local)

  const state = new Map<string, SharedFixtureSpace>()
  const targetVersion = options.currentProduction ? 20 : 2
  addSharedFixtureSpace(
    local,
    state,
    slug,
    definition,
    SPACE,
    options.currentProduction ? 20 : 1,
    targetVersion,
    false,
    options.currentProduction ? 'source-session' : BUILT_IN_WORKFLOW_AUTHOR,
    options.currentProduction,
  )
  addSharedFixtureSpace(
    local,
    state,
    slug,
    definition,
    FOLLOWER_SPACE,
    options.currentProduction ? 17 : 1,
    options.currentProduction ? 17 : options.pinned ? 2 : 1,
    options.pinned ?? false,
    options.currentProduction ? 'follower-session' : BUILT_IN_WORKFLOW_AUTHOR,
    options.currentProduction,
  )
  if (options.secondFollower)
    addSharedFixtureSpace(
      local,
      state,
      slug,
      definition,
      SECOND_FOLLOWER_SPACE,
      17,
      17,
      false,
      'second-follower-session',
      true,
    )

  if (options.catalogueAdvance) {
    const source = state.get(SPACE)!
    source.catalogueVersions[0]!.status = 'retired'
    source.catalogueVersions[0]!.retiredAt = at
    const nextCatalogue = structuredClone(productionStepCatalogue(local).definition)
    nextCatalogue.steps.push({ ...nextCatalogue.steps[0]!, slug: 'new-shared-step' })
    source.catalogueVersions.push({
      ...source.catalogueVersions[0]!,
      id: newRecordId(),
      n: 2,
      status: 'production',
      definition: JSON.stringify(nextCatalogue),
      promotedAt: at,
      retiredAt: null,
    })
    const sourceTarget = source.versions.find((version) => version.n === targetVersion)!
    const targetDefinition = JSON.parse(sourceTarget.definition) as WorkflowDefinition
    targetDefinition.modes[0]!.steps = ['new-shared-step']
    sourceTarget.definition = JSON.stringify(targetDefinition)
  }

  const calls: string[] = []
  process.env.ORCH_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      ...(await whoami()),
      memberships: [
        SPACE,
        FOLLOWER_SPACE,
        ...(options.secondFollower ? [SECOND_FOLLOWER_SPACE] : []),
      ].map((spaceId) => ({
        space_id: spaceId,
        name: spaceId,
        slug: spaceId,
        role: 'owner',
        permission: 'write',
      })),
    }),
    async listWorkflowCatalogue(table, _query, destination) {
      const spaceId = destination?.destinationSpaceId
      if (!spaceId) throw new Error('test expected a destination space')
      if (options.unreadable && spaceId === FOLLOWER_SPACE && table === 'workflow')
        throw new Error('hosted read failed')
      const current = state.get(spaceId)!
      return { items: sharedFixtureItems(table, current), nextCursor: null }
    },
    async draftWorkflow(input, destination) {
      const spaceId = destination?.destinationSpaceId
      if (!spaceId) throw new Error('test expected a destination space')
      const current = state.get(spaceId)!
      const catalogue = input.kind === 'step_catalogue'
      calls.push(`${catalogue ? 'catalogue-' : ''}draft:${spaceId}:${input.reason}`)
      const versions = catalogue ? current.catalogueVersions : current.versions
      const identity = catalogue ? current.catalogueIdentity : current.identity
      const version = {
        id: newRecordId(),
        spaceId,
        ownerId: identity.id,
        n: versions.length + 1,
        status: 'draft' as const,
        definition: input.definition!,
        author: input.author,
        reason: input.reason,
        createdAt: at,
        promotedAt: null,
        retiredAt: null,
        updatedAt: at,
      }
      versions.push(version)
      return { identity, versions: [version], events: [] }
    },
    async promoteWorkflow(input, destination) {
      const spaceId = destination?.destinationSpaceId
      if (!spaceId) throw new Error('test expected a destination space')
      const current = state.get(spaceId)!
      const catalogue = input.kind === 'step_catalogue'
      calls.push(`${catalogue ? 'catalogue-' : ''}promote:${spaceId}:${input.reason}`)
      const versions = catalogue ? current.catalogueVersions : current.versions
      const identity = catalogue ? current.catalogueIdentity : current.identity
      for (const version of versions) {
        if (version.status === 'production') version.status = 'retired'
        if (version.n === input.n) version.status = 'production'
      }
      const event = {
        id: newRecordId(),
        spaceId,
        ownerVersionId: versions.find((row) => row.n === input.n)!.id,
        event: 'promote' as const,
        author: input.author,
        reason: input.reason,
        sessionId: null,
        at,
      }
      if (!catalogue) current.events.push({ ...event, updatedAt: at })
      return { identity, versions, events: [event] }
    },
  })
  return { slug, calls, targetVersion, state }
}

test('shared hosted promotion reads every space, copies followers, and reports all changes', async () => {
  const fixture = installSharedPromotionFixture()
  expect(await promoteWorkflow(fixture.slug, 2, 'release')).toEqual({
    version: 2,
    changedSpaces: ['local', SPACE, FOLLOWER_SPACE],
    overrideSpaces: [],
    pinnedSpaces: [],
  })
  expect(fixture.calls).toEqual([
    `promote:${SPACE}:shared promotion: release`,
    `draft:${FOLLOWER_SPACE}:seed two`,
    `promote:${FOLLOWER_SPACE}:shared promotion: release`,
  ])
})

test('shared hosted promotion gives a follower the required catalogue before the workflow', async () => {
  const fixture = installSharedPromotionFixture({ catalogueAdvance: true })
  expect(await promoteWorkflow(fixture.slug, 2, 'release')).toEqual({
    version: 2,
    changedSpaces: ['local', SPACE, FOLLOWER_SPACE],
    overrideSpaces: [],
    pinnedSpaces: [],
  })
  expect(fixture.calls).toEqual([
    `catalogue-draft:${FOLLOWER_SPACE}:test`,
    `catalogue-promote:${FOLLOWER_SPACE}:shared promotion: release`,
    `promote:${SPACE}:shared promotion: release`,
    `draft:${FOLLOWER_SPACE}:seed two`,
    `promote:${FOLLOWER_SPACE}:shared promotion: release`,
  ])
})

test('shared hosted promotion keeps and reports a space-specific pin', async () => {
  const fixture = installSharedPromotionFixture({ pinned: true })
  expect(await promoteWorkflow(fixture.slug, 2, 'release')).toEqual({
    version: 2,
    changedSpaces: ['local', SPACE],
    overrideSpaces: [],
    pinnedSpaces: [FOLLOWER_SPACE],
  })
  expect(fixture.calls).toEqual([`promote:${SPACE}:shared promotion: release`])
})

test('shared hosted promotion refuses before writing when a target cannot be read', async () => {
  const fixture = installSharedPromotionFixture({ unreadable: true })
  await expect(promoteWorkflow(fixture.slug, 2, 'release')).rejects.toThrow(
    `could not read authoritative workflow state for space ${FOLLOWER_SPACE}: hosted read failed; refresh and retry`,
  )
  expect(fixture.calls).toEqual([])
})

test('shared hosted promotion copies through current production without writing the source', async () => {
  const fixture = installSharedPromotionFixture({ currentProduction: true, secondFollower: true })
  expect(await promoteWorkflow(fixture.slug, fixture.targetVersion, 'release')).toEqual({
    version: 20,
    changedSpaces: [FOLLOWER_SPACE, SECOND_FOLLOWER_SPACE],
    overrideSpaces: [],
    pinnedSpaces: [],
  })
  expect(fixture.calls).toEqual(
    [FOLLOWER_SPACE, SECOND_FOLLOWER_SPACE].flatMap((spaceId) => [
      `draft:${spaceId}:version 18`,
      `draft:${spaceId}:version 19`,
      `draft:${spaceId}:version 20`,
      `promote:${spaceId}:shared promotion: release`,
    ]),
  )
  const sourceVersions = fixture.state.get(SPACE)!.versions
  for (const spaceId of [FOLLOWER_SPACE, SECOND_FOLLOWER_SPACE]) {
    const followerVersions = fixture.state.get(spaceId)!.versions
    for (const n of [18, 19, 20])
      expect(followerVersions.find((version) => version.n === n)!.definition).toBe(
        sourceVersions.find((version) => version.n === n)!.definition,
      )
  }
})
