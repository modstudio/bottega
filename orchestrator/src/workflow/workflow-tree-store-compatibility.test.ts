import { expect, test } from 'bun:test'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { productionStepCatalogue, setStepCatalogueLocal } from './step-catalogue.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { planWorkflowHydration } from './workflow-tree.ts'
import { newestDraftWorkflowTree } from './workflow-tree-store.ts'

const database = testDatabaseFixture(seedWorkflows)

test('a legacy draft catalogue reads and renders in the current shape', () => {
  const d = database()
  const production = productionStepCatalogue(d).definition
  const legacy = structuredClone(production) as typeof production & {
    steps: ((typeof production.steps)[number] & { job?: string })[]
  }
  const target = legacy.steps[0]!
  target.job = 'implement'
  delete (target as Partial<typeof target>).jobs
  delete (target as Partial<typeof target>).actions
  const draft = setStepCatalogueLocal(production, 'legacy catalogue fixture', 'test', d)
  d.query('UPDATE step_catalogue_version SET definition=? WHERE n=?').run(
    JSON.stringify(legacy),
    draft.n,
  )

  const result = newestDraftWorkflowTree({ database: d })
  const step = result.steps.find(({ slug }) => slug === target.slug)

  expect(step?.jobs).toEqual(['implement'])
  expect(step?.actions).toEqual([])
  expect(() => planWorkflowHydration({ store: result, tree: [] })).not.toThrow()
})
