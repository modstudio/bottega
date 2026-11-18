import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { projects } from '../project/projects.ts'
import {
  promoteStepCatalogueLocal,
  setStepCatalogueLocal,
  type StepCatalogueDefinition,
} from './step-catalogue.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { checkResolvedWorkflowRendering } from './workflow-render-check-store.ts'
import { promoteWorkflowLocal, setWorkflowLocal, type WorkflowDefinition } from './workflows.ts'

const catalogue: StepCatalogueDefinition = {
  steps: [
    {
      slug: 'collect',
      title: 'Collect signals',
      body: 'Collect signals.',
      floor: ['recorded-artifact'],
      jobs: [],
      actions: [],
      stage: 'review',
      autonomy: 'auto',
      needs: ['signals'],
    },
  ],
}

const workflow: WorkflowDefinition = {
  title: 'Signal workflow',
  description: 'Needs project signals.',
  arguments: [],
  modes: [{ slug: 'default', title: 'Default', default: true, steps: ['collect'] }],
}

const database = testDatabaseFixture((d) => {
  const catalogueDraft = setStepCatalogueLocal(catalogue, 'render check fixture', 'test', d)
  promoteStepCatalogueLocal(catalogueDraft.n, 'render check fixture', 'test', d)
  for (const slug of ['composed', 'never-composed']) {
    const draft = setWorkflowLocal(slug, workflow, 'render check fixture', 'test', d)
    promoteWorkflowLocal(slug, draft.n, 'render check fixture', 'test', d)
  }
  d.query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)').run(
    '01990000-0000-7000-8000-000000002425',
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({
      docs: { protocol: 'orch-docs' },
      signals: { sources: [{ name: 'fixture', list: 'true' }] },
    }),
  )
})

test('resolved render check separates composed and never-composed fact misses', async () => {
  const d = database()
  await composeWorkflowWithCursor(
    'composed',
    'fixture',
    'default',
    {},
    { session: 'render-check-test' },
    d,
    {},
    {},
  )
  d.query('UPDATE project SET settings=? WHERE name=?').run(
    JSON.stringify({ docs: { protocol: 'orch-docs' } }),
    'fixture',
  )

  const result = await checkResolvedWorkflowRendering(d, projects(undefined, d))
  const remedy =
    `signals; set with: ${PLATFORM_SLUG} project set fixture --settings ` +
    `'{"signals":{"sources":[{"name":"<label>","list":"<command-or-tool>"}]}}'`

  expect(result.unresolvedProjects).toEqual([
    { project: 'fixture', workflows: ['composed'], facts: [remedy] },
  ])
  expect(result.notApplicable).toEqual([
    { project: 'fixture', workflows: ['never-composed'], facts: [remedy] },
  ])
})
