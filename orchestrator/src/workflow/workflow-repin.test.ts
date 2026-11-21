import { expect, test } from 'bun:test'
import {
  productionStepCatalogue,
  promoteStepCatalogueLocal,
  setStepCatalogueLocal,
} from './step-catalogue.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { args, context, database } from './workflow-cursor-test.fixture.ts'
import { repinWorkflowCursor } from './workflow-repin.ts'

test('repin writes current versions, total steps, and an audit trail entry', async () => {
  const d = database()
  const composed = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    args,
    context,
    d,
    {},
    {},
  )
  const original = (await taskFlowReadStore(d).stageByHandle('fixture', composed.cursor!.id))!
  const production = productionStepCatalogue(d).definition
  const draft = setStepCatalogueLocal(
    {
      ...production,
      steps: production.steps.map((step) =>
        step.slug === original.step_slug
          ? { ...step, outcomes: ['kept'], outcomeFloors: { kept: ['ruling'] } }
          : step,
      ),
    },
    'repin fixture',
    'test',
    d,
  )
  promoteStepCatalogueLocal(draft.n, 'repin fixture', 'test', d)

  const result = await repinWorkflowCursor({
    row: original,
    reason: 'adopt the current outcome',
    context,
    database: d,
  })
  const updated = (await taskFlowReadStore(d).stageByHandle('fixture', original.id))!
  const trail = JSON.parse(updated.closed) as Array<Record<string, unknown>>

  expect(result.catalogueVersion).toEqual({ from: original.catalogue_version, to: draft.n })
  expect(updated.catalogue_version).toBe(draft.n)
  expect(updated.workflow_version).toBe(original.workflow_version)
  expect(updated.total_steps).toBe(composed.steps.length)
  expect(trail.at(-1)).toMatchObject({
    event: 'repinned',
    catalogue: { from: original.catalogue_version, to: draft.n },
    reason: 'adopt the current outcome',
    callerSession: context.session,
  })
})
