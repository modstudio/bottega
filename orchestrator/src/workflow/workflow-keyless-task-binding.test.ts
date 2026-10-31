import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { newRecordId } from '../../../shared/record-id.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogueLocal,
  setStepCatalogueLocal,
} from './step-catalogue.ts'
import {
  composeWorkflowWithCursor,
  getWorkflowStepWithCursor,
  nextWorkflowStep,
} from './workflow-cursor.ts'
import { testPorts } from './workflow-cursor-test.fixture.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { parseWorkflowTree } from './workflow-tree.ts'
import { collectWorkflowTree } from './workflow-tree-files.ts'
import {
  composeWorkflow,
  getWorkflowStep,
  promoteWorkflowLocal,
  setWorkflowLocal,
} from './workflows.ts'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const tree = parseWorkflowTree(collectWorkflowTree(root))
const planTask = tree.workflows.find(({ slug }) => slug === 'plan-task')!

const database = testDatabaseFixture((d) => {
  seedWorkflows(d)
  d.query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)').run(
    newRecordId(),
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({ tracker: { protocol: 'hub' }, docs: { protocol: 'orch-docs' } }),
  )
  const catalogue = setStepCatalogueLocal(
    { steps: tree.steps, sequences: tree.sequences },
    'current tree fixture',
    'test',
    d,
  )
  promoteStepCatalogueLocal(catalogue.n, 'current tree fixture', 'test', d)
  const workflow = setWorkflowLocal(
    planTask.slug,
    planTask.definition,
    'current tree fixture',
    'test',
    d,
  )
  promoteWorkflowLocal(planTask.slug, workflow.n, 'current tree fixture', 'test', d)
})

test('every plan-task step renders on a keyless cursor in every mode', () => {
  const d = database()
  for (const mode of planTask.definition.modes) {
    const composition = composeWorkflow('plan-task', 'fixture', mode.slug, {}, d)
    for (const { slug } of composition.steps) {
      const step = getWorkflowStep('plan-task', 'fixture', slug, {}, d, { mode: mode.slug })
      expect(step.body).not.toContain('{{tracker.actions.')
    }
  }
})

test('a keyless step using KEY binds before it advances', () => {
  const d = database()
  const current = productionStepCatalogue(d).definition
  const catalogue = setStepCatalogueLocal(
    {
      ...current,
      steps: [
        ...current.steps,
        {
          slug: 'bind-task',
          title: 'Bind task',
          body: 'Update with {{tracker.actions.update}}.',
          stage: 'plan',
          floor: ['tracker-transition'],
          job: null,
          autonomy: 'auto',
          needs: ['tracker'],
        },
        {
          slug: 'read-bound-task',
          title: 'Read bound task',
          body: 'Read with {{tracker.actions.get}}.',
          stage: 'plan',
          floor: ['tracker-transition'],
          job: null,
          autonomy: 'auto',
          needs: ['tracker'],
        },
      ],
    },
    'keyless binding fixture',
    'test',
    d,
  )
  promoteStepCatalogueLocal(catalogue.n, 'keyless binding fixture', 'test', d)
  const workflow = setWorkflowLocal(
    'keyless-binding',
    {
      title: 'Keyless binding',
      description: 'Binds a created task.',
      arguments: [{ name: 'key', required: false, description: 'Task key.' }],
      modes: [
        {
          slug: 'default',
          title: 'Default',
          default: true,
          steps: ['bind-task', 'read-bound-task'],
        },
      ],
    },
    'keyless binding fixture',
    'test',
    d,
  )
  promoteWorkflowLocal('keyless-binding', workflow.n, 'keyless binding fixture', 'test', d)

  const context = { session: 'keyless-binding-session' }
  const opened = composeWorkflowWithCursor(
    'keyless-binding',
    'fixture',
    'default',
    {},
    context,
    d,
    {},
    {},
  )
  const cursor = opened.cursor!.id
  const served = getWorkflowStepWithCursor(
    'keyless-binding',
    'fixture',
    'bind-task',
    {},
    'default',
    context,
    d,
    {},
    cursor,
  )
  expect(served.body).toContain('<KEY>')

  expect(() =>
    nextWorkflowStep(
      'keyless-binding',
      'fixture',
      'default',
      {},
      'created task',
      context,
      d,
      {},
      testPorts,
      cursor,
    ),
  ).toThrow(`--cursor ${cursor} --task <KEY>`)
  expect(
    d.query('SELECT ordinal,workflow_key FROM workflow_cursor WHERE number=?').get(cursor),
  ).toEqual({ ordinal: 0, workflow_key: '' })

  const advanced = nextWorkflowStep(
    'keyless-binding',
    'fixture',
    'default',
    {},
    'created task',
    context,
    d,
    { task: 'DEV-822' },
    testPorts,
    cursor,
  )
  expect(advanced).toContain('DEV-822')
  expect(advanced).not.toContain('task show <KEY>')
})

test('a key argument cannot stand in for task adoption on a keyless cursor', () => {
  const d = database()
  const opened = composeWorkflowWithCursor(
    'plan-task',
    'fixture',
    'requirements',
    {},
    { session: 'key-mismatch-session' },
    d,
    {},
    {},
  )
  expect(() =>
    getWorkflowStepWithCursor(
      'plan-task',
      'fixture',
      'dedupe',
      { key: 'DEV-1873' },
      'requirements',
      { session: 'key-mismatch-session' },
      d,
      {},
      opened.cursor!.id,
    ),
  ).toThrow(`workflow next plan-task --cursor ${opened.cursor!.id} --task <KEY>`)
})

test('compose refuses an undeclared argument and lists the declared arguments', () => {
  expect(() =>
    composeWorkflow('plan-task', 'fixture', 'requirements', { typo: 'value' }, database()),
  ).toThrow('workflow "plan-task" has no argument "typo"; declared arguments: key')
})
