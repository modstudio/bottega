import { afterEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { applyWorkflowCatalogueRow } from '../record/record-cache-workflow.ts'
import { productionStepCatalogue } from './step-catalogue.ts'
import { importWorkflow, productionWorkflows, promoteWorkflow, setWorkflow } from './workflows.ts'

const SPACE = '01990000-0000-7000-8000-000000000222'
const at = '2026-10-18T12:00:00.000Z'
const whoami = async () => ({
  user: { id: newRecordId() },
  activeSpaceId: SPACE,
  personalSpaceId: SPACE,
  memberships: [],
})
function installHostedCatalogue(): void {
  const local = db(),
    ownerId = newRecordId(),
    versionId = newRecordId()
  applyWorkflowCatalogueRow(local, 'step_catalogue', {
    id: ownerId,
    spaceId: SPACE,
    slug: 'shared',
    createdAt: at,
    updatedAt: at,
  })
  applyWorkflowCatalogueRow(local, 'step_catalogue_version', {
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
  })
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
  installHostedCatalogue()
  const local = db(),
    definition = productionWorkflows(local, null)[0]!.definition
  const ownerId = newRecordId(),
    versionId = newRecordId(),
    setEventId = newRecordId()
  process.env.ORCH_RECORD_API_URL = 'https://record.example.test'
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami,
    async draftWorkflow() {
      return {
        identity: {
          id: ownerId,
          spaceId: SPACE,
          slug: 'hosted-promote',
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
    async promoteWorkflow() {
      return {
        identity: {
          id: ownerId,
          spaceId: SPACE,
          slug: 'hosted-promote',
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
  expect((await promoteWorkflow('hosted-promote', 1, 'promote')).status).toBe('production')
  expect(
    local.query('SELECT status FROM workflow_version WHERE record_id=?').get(versionId),
  ).toEqual({ status: 'production' })
  expect(
    local.query('SELECT record_id FROM workflow_event WHERE record_id=?').get(promoteEventId),
  ).toEqual({ record_id: promoteEventId })
})
