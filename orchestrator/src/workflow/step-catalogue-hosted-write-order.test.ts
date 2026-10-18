import { afterEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { applyWorkflowCatalogueRow } from '../record/record-cache-workflow.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogue,
  setStepCatalogue,
} from './step-catalogue.ts'

const SPACE = '01990000-0000-7000-8000-000000000223'
const at = '2026-10-18T12:00:00.000Z'
const whoami = async () => ({
  user: { id: newRecordId() },
  activeSpaceId: SPACE,
  personalSpaceId: SPACE,
  memberships: [],
})

afterEach(() => {
  delete process.env.ORCH_RECORD_API_URL
  installRecordApiClient(createMemoryRecordApiClient())
})

test('hosted catalogue set and promote are inert on failure and adopt hosted ids on success', async () => {
  const local = db(),
    definition = productionStepCatalogue(local).definition,
    localCounts = local
      .query(
        `SELECT
          (SELECT COUNT(*) FROM step_catalogue WHERE space_id IS NULL) identities,
          (SELECT COUNT(*) FROM step_catalogue_version WHERE space_id IS NULL) versions,
          (SELECT COUNT(*) FROM step_catalogue_event WHERE space_id IS NULL) events`,
      )
      .get(),
    ownerId = newRecordId(),
    versionId = newRecordId(),
    setEventId = newRecordId()
  process.env.ORCH_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami,
    async draftWorkflow() {
      throw new Error('hosted catalogue set failed')
    },
  })
  await expect(setStepCatalogue(definition, 'set')).rejects.toThrow('hosted catalogue set failed')
  expect(local.query('SELECT COUNT(*) n FROM step_catalogue WHERE space_id=?').get(SPACE)).toEqual({
    n: 0,
  })

  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami,
    async draftWorkflow() {
      return {
        identity: {
          id: ownerId,
          spaceId: SPACE,
          slug: 'shared',
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
            id: setEventId,
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
    async promoteWorkflow() {
      throw new Error('hosted catalogue promote failed')
    },
  })
  expect((await setStepCatalogue(definition, 'set')).n).toBe(1)
  await expect(promoteStepCatalogue(1, 'promote')).rejects.toThrow(
    'hosted catalogue promote failed',
  )
  expect(
    local.query('SELECT status FROM step_catalogue_version WHERE record_id=?').get(versionId),
  ).toEqual({
    status: 'draft',
  })

  const promoteEventId = newRecordId()
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami,
    async promoteWorkflow() {
      return {
        identity: {
          id: ownerId,
          spaceId: SPACE,
          slug: 'shared',
          createdAt: at,
          updatedAt: at,
        },
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
  expect((await promoteStepCatalogue(1, 'promote')).status).toBe('production')
  expect(local.query('SELECT record_id FROM step_catalogue WHERE space_id=?').get(SPACE)).toEqual({
    record_id: ownerId,
  })
  expect(
    local.query('SELECT record_id FROM step_catalogue_version WHERE space_id=?').get(SPACE),
  ).toEqual({
    record_id: versionId,
  })
  expect(
    local.query('SELECT record_id FROM step_catalogue_event WHERE record_id=?').get(promoteEventId),
  ).toEqual({
    record_id: promoteEventId,
  })
  expect(
    local
      .query(
        `SELECT
        (SELECT COUNT(*) FROM step_catalogue WHERE space_id IS NULL) identities,
        (SELECT COUNT(*) FROM step_catalogue_version WHERE space_id IS NULL) versions,
        (SELECT COUNT(*) FROM step_catalogue_event WHERE space_id IS NULL) events`,
      )
      .get(),
  ).toEqual(localCounts)
})

test('hosted catalogue promotion does not call the API when it removes a live reference', async () => {
  const local = db(),
    production = productionStepCatalogue(local).definition,
    referenced = production.steps[0]!,
    catalogueId = newRecordId(),
    productionVersionId = newRecordId(),
    draftVersionId = newRecordId(),
    workflowId = newRecordId()
  applyWorkflowCatalogueRow(local, 'step_catalogue', {
    id: catalogueId,
    spaceId: SPACE,
    slug: 'shared',
    createdAt: at,
    updatedAt: at,
  })
  for (const row of [
    {
      id: productionVersionId,
      n: 1,
      status: 'production',
      definition: production,
      promotedAt: at,
    },
    {
      id: draftVersionId,
      n: 2,
      status: 'draft',
      definition: { ...production, steps: production.steps.slice(1) },
      promotedAt: null,
    },
  ])
    applyWorkflowCatalogueRow(local, 'step_catalogue_version', {
      ...row,
      spaceId: SPACE,
      ownerId: catalogueId,
      definition: JSON.stringify(row.definition),
      author: 'test',
      reason: 'test',
      createdAt: at,
      retiredAt: null,
      updatedAt: at,
    })
  applyWorkflowCatalogueRow(local, 'workflow', {
    id: workflowId,
    spaceId: SPACE,
    slug: 'live-flow',
    createdAt: at,
    updatedAt: at,
  })
  applyWorkflowCatalogueRow(local, 'workflow_version', {
    id: newRecordId(),
    spaceId: SPACE,
    ownerId: workflowId,
    n: 1,
    status: 'production',
    definition: JSON.stringify({
      title: 'Live flow',
      description: '',
      arguments: [],
      modes: [{ slug: 'default', title: 'Default', default: true, steps: [referenced.slug] }],
    }),
    author: 'test',
    reason: 'test',
    createdAt: at,
    promotedAt: at,
    retiredAt: null,
    updatedAt: at,
  })
  let calls = 0
  process.env.ORCH_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami,
    async promoteWorkflow() {
      calls++
      throw new Error('API must not be called')
    },
  })

  await expect(promoteStepCatalogue(2, 'remove live reference')).rejects.toThrow('live-flow')
  expect(calls).toBe(0)
})
