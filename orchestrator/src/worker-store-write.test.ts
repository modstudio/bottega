import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { applyMigrations } from './database/migrations.ts'
import { importCanon } from './doc/canon-import.ts'
import { consumeDoc, importDoc, importDocs, removeDoc, restoreDoc, setDoc } from './doc/docs.ts'
import { workerStoreWriteRefusal } from './worker-store-write.ts'
import {
  forkStepCatalogue,
  importStepCatalogue,
  productionStepCatalogue,
  promoteStepCatalogue,
  retireStepCatalogue,
  setStepCatalogue,
} from './workflow/step-catalogue.ts'
import { seedWorkflows } from './workflow/workflow-seeds.ts'
import {
  forkWorkflow,
  importWorkflow,
  productionWorkflows,
  promoteWorkflow,
  retireWorkflow,
  setWorkflow,
} from './workflow/workflows.ts'

let priorRunId: string | undefined

beforeEach(() => {
  priorRunId = process.env.ORCH_RUN_ID
  delete process.env.ORCH_RUN_ID
})

afterEach(() => {
  if (priorRunId === undefined) delete process.env.ORCH_RUN_ID
  else process.env.ORCH_RUN_ID = priorRunId
})

describe('worker shared-text store writes', () => {
  test.each(['ORCH_RUN_ID', 'ORCH_DEPTH'] as const)('refuses when %s marks a worker', (marker) => {
    const refusal = workerStoreWriteRefusal('workflow', 'orch workflow import', {
      [marker]: '42',
    })
    expect(refusal).toContain('refusing workflow store write from an orch worker run')
    expect(refusal).toContain('ORCH_RUN_ID or ORCH_DEPTH marks this process as a worker run')
    expect(refusal).toContain('write the intended hydrated file in your tree')
    expect(refusal).toContain('state the exact store change in your reply')
    expect(refusal).toContain('architect apply it after review and before the final gate')
  })

  test('allows an architect process', () => {
    expect(workerStoreWriteRefusal('document', 'orch doc set', {})).toBeNull()
  })

  test('every document-row write service allows an architect and refuses a worker', async () => {
    const created = await setDoc({
      scope: 'global',
      subject: null,
      slug: 'worker-service-guard',
      title: 'Worker service guard',
      body: 'Architect-created fixture.',
      delivery: 'demand',
      reason: 'prove architect write',
    })
    expect(created.slug).toBe('worker-service-guard')

    process.env.ORCH_RUN_ID = 'doc-service-worker'
    const refusal = 'refusing document store write from an orch worker run'
    await expect(
      setDoc({
        scope: 'global',
        subject: null,
        slug: 'worker-set',
        title: 'Worker set',
        body: 'Refused.',
        reason: 'worker fixture',
      }),
    ).rejects.toThrow(refusal)
    await expect(
      importDoc({
        scope: 'global',
        subject: null,
        slug: 'worker-import',
        title: 'Worker import',
        body: 'Refused.',
        reason: 'worker fixture',
      }),
    ).rejects.toThrow(refusal)
    await expect(
      removeDoc('global', null, created.slug, {
        reason: 'worker fixture',
        expectedRevision: created.revision!,
      }),
    ).rejects.toThrow(refusal)
    await expect(
      consumeDoc('global', null, created.slug, { reason: 'worker fixture' }),
    ).rejects.toThrow(refusal)
    await expect(importDocs('/does/not/matter', { reason: 'worker fixture' })).rejects.toThrow(
      refusal,
    )
    await expect(
      restoreDoc('global', null, created.slug, 1, { reason: 'worker fixture' }),
    ).rejects.toThrow(refusal)
    await expect(
      importCanon({
        address: { kind: 'project', subject: 'unused', projectId: 1 },
        rows: [],
        reason: 'worker fixture',
      }),
    ).rejects.toThrow(refusal)
  })

  test('every workflow and catalogue write service allows an architect and refuses a worker', () => {
    const d = new Database(':memory:')
    d.exec('PRAGMA foreign_keys=ON')
    applyMigrations(d)
    seedWorkflows(d)
    const catalogue = productionStepCatalogue(d)
    const workflow = productionWorkflows(d)[0]!
    const architectCatalogue = setStepCatalogue(
      catalogue.definition,
      'architect catalogue fixture',
      'architect',
      d,
    )
    const architectWorkflow = setWorkflow(
      'worker-guard-architect',
      workflow.definition,
      'architect workflow fixture',
      'architect',
      d,
    )
    expect(architectCatalogue.status).toBe('draft')
    expect(architectWorkflow.status).toBe('draft')

    process.env.ORCH_RUN_ID = 'workflow-service-worker'
    const refusal = 'refusing workflow store write from an orch worker run'
    const workflowWrites = [
      () => setWorkflow('worker-set', workflow.definition, 'worker fixture', 'worker', d),
      () => importWorkflow('worker-import', workflow.definition, 'worker fixture', 'worker', d),
      () => forkWorkflow(workflow.slug, undefined, 'worker fixture', 'worker', d),
      () =>
        promoteWorkflow(
          'worker-guard-architect',
          architectWorkflow.n,
          'worker fixture',
          'worker',
          d,
        ),
      () => retireWorkflow(workflow.slug, 1, 'worker fixture', 'worker', d),
    ]
    const catalogueWrites = [
      () => setStepCatalogue(catalogue.definition, 'worker fixture', 'worker', d),
      () => importStepCatalogue(catalogue.definition, 'worker fixture', 'worker', d),
      () => forkStepCatalogue(undefined, 'worker fixture', 'worker', d),
      () => promoteStepCatalogue(architectCatalogue.n, 'worker fixture', 'worker', d),
      () => retireStepCatalogue(catalogue.n, 'worker fixture', 'worker', d),
    ]
    for (const write of [...workflowWrites, ...catalogueWrites]) expect(write).toThrow(refusal)
    d.close()
  })
})
