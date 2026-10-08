import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogue,
  setStepCatalogue,
} from './step-catalogue.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { resolveWorkflowStepReference } from './workflow-step-reference.ts'
import { installWorkflowStoreFixture } from './workflow-store.fixture.ts'
import {
  composeWorkflow,
  getWorkflowStep,
  promoteWorkflow,
  setWorkflow,
  type WorkflowDefinition,
  workflowModeStepLists,
} from './workflows.ts'

const definition = (steps: WorkflowDefinition['modes'][number]['steps']): WorkflowDefinition => ({
  title: 'A workflow',
  description: 'Does work.',
  arguments: [
    { name: 'key', required: true, description: 'Task key' },
    { name: 'branch', required: true, description: 'Branch' },
    { name: 'worktree', required: true, description: 'Worktree' },
  ],
  modes: [{ slug: 'default', title: 'Default', default: true, steps }],
})

const database = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  seedWorkflows(d)
  installWorkflowStoreFixture(d)
  d.query('INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?)').run(
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({
      gate: 'bun run check',
      trunk: 'develop',
      docs: { protocol: 'orch-docs' },
      tracker: { protocol: 'hub' },
    }),
  )
  return d
}

test('sequence and flat modes compose, look up, and number identically', () => {
  const d = database()
  const current = productionStepCatalogue(d).definition
  const catalogue = setStepCatalogue(
    {
      steps: current.steps,
      sequences: [{ slug: 'quality', title: 'Quality', steps: ['lens', 'score'] }],
    },
    'sequence fixture',
    'test',
    d,
  )
  promoteStepCatalogue(catalogue.n, 'publish', 'test', d)
  for (const [slug, steps] of [
    ['flat-fixture', ['rebase', 'lens', 'score', 'close']],
    ['sequence-fixture', ['rebase', { sequence: 'quality' }, 'close']],
  ] as const) {
    const draft = setWorkflow(slug, definition([...steps]), 'sequence fixture', 'test', d)
    promoteWorkflow(slug, draft.n, 'publish', 'test', d)
  }

  const args = { key: 'DEV-1195', branch: 'DEV-1195-sequences', worktree: '/tmp/fixture' }
  const flat = composeWorkflow('flat-fixture', 'fixture', 'default', args, d)
  const sequence = composeWorkflow('sequence-fixture', 'fixture', 'default', args, d)
  expect(sequence.steps.map(({ slug }) => slug)).toEqual(flat.steps.map(({ slug }) => slug))
  expect(
    getWorkflowStep('sequence-fixture', 'fixture', 'lens', args, d, { mode: 'default' }).next,
  ).toEqual(getWorkflowStep('flat-fixture', 'fixture', 'lens', args, d, { mode: 'default' }).next)
  expect(resolveWorkflowStepReference('3', workflowModeStepLists('sequence-fixture', d))).toBe(
    'score',
  )
})
