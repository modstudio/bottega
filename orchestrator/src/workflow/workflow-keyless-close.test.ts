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
import { KEYLESS_TRACKER_ACTION_KEY } from './workflow-template.ts'
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

test('a workflow without a key argument adopts --task and renders and closes its next step', () => {
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
      arguments: [],
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
  expect(served.body).toContain(KEYLESS_TRACKER_ACTION_KEY)

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
  expect(advanced).not.toContain(`task show ${KEYLESS_TRACKER_ACTION_KEY}`)
  expect(
    nextWorkflowStep(
      'keyless-binding',
      'fixture',
      'default',
      {},
      'read the bound task',
      context,
      d,
      { task: 'DEV-822' },
      testPorts,
      cursor,
    ),
  ).toContain('is finished')
})

test('a prose KEY marker without a key-bound tracker action closes keylessly', () => {
  const d = database()
  const current = productionStepCatalogue(d).definition
  const catalogue = setStepCatalogueLocal(
    {
      ...current,
      steps: [
        ...current.steps,
        {
          slug: 'prose-key-marker',
          title: 'Prose key marker',
          body: `Document ${KEYLESS_TRACKER_ACTION_KEY} as an example.`,
          stage: 'plan',
          floor: ['ruling'],
          job: null,
          autonomy: 'auto',
          needs: [],
        },
      ],
    },
    'prose key marker fixture',
    'test',
    d,
  )
  promoteStepCatalogueLocal(catalogue.n, 'prose key marker fixture', 'test', d)
  const workflow = setWorkflowLocal(
    'prose-key-marker',
    {
      title: 'Prose key marker',
      description: 'Mentions the marker without using a tracker action.',
      arguments: [],
      modes: [
        {
          slug: 'default',
          title: 'Default',
          default: true,
          steps: ['prose-key-marker'],
        },
      ],
    },
    'prose key marker fixture',
    'test',
    d,
  )
  promoteWorkflowLocal('prose-key-marker', workflow.n, 'prose key marker fixture', 'test', d)
  const context = { session: 'prose-key-marker-session' }
  const opened = composeWorkflowWithCursor(
    'prose-key-marker',
    'fixture',
    'default',
    {},
    context,
    d,
    {},
    {},
  )

  expect(
    nextWorkflowStep(
      'prose-key-marker',
      'fixture',
      'default',
      {},
      'documented the example',
      context,
      d,
      {},
      testPorts,
      opened.cursor!.id,
      { ruling: 'Proceed.', basis: 'the test fixture', channel: 'mcp' },
    ),
  ).toContain('is finished')
})

test('next refuses an undeclared argument before storing it and a correct next still renders', () => {
  const d = database()
  const current = productionStepCatalogue(d).definition
  const catalogue = setStepCatalogueLocal(
    {
      ...current,
      steps: [
        ...current.steps,
        {
          slug: 'argument-entry',
          title: 'Argument entry',
          body: 'Close with a declared argument.',
          stage: 'plan',
          floor: ['ruling'],
          job: null,
          autonomy: 'auto',
          needs: [],
        },
        {
          slug: 'argument-rendered',
          title: 'Argument rendered',
          body: 'Rendered after valid next.',
          stage: 'plan',
          floor: ['ruling'],
          job: null,
          autonomy: 'auto',
          needs: [],
        },
      ],
    },
    'unknown next argument fixture',
    'test',
    d,
  )
  promoteStepCatalogueLocal(catalogue.n, 'unknown next argument fixture', 'test', d)
  const workflow = setWorkflowLocal(
    'unknown-next-argument',
    {
      title: 'Unknown next argument',
      description: 'Refuses unknown arguments before persistence.',
      arguments: [{ name: 'key', required: false, description: 'Task key.' }],
      modes: [
        {
          slug: 'default',
          title: 'Default',
          default: true,
          steps: ['argument-entry', 'argument-rendered'],
        },
      ],
    },
    'unknown next argument fixture',
    'test',
    d,
  )
  promoteWorkflowLocal(
    'unknown-next-argument',
    workflow.n,
    'unknown next argument fixture',
    'test',
    d,
  )
  const context = { session: 'unknown-next-argument-session' }
  const opened = composeWorkflowWithCursor(
    'unknown-next-argument',
    'fixture',
    'default',
    {},
    context,
    d,
    {},
    {},
  )
  const cursor = opened.cursor!.id
  const before = d
    .query<{ args: string }, [number]>('SELECT args FROM workflow_cursor WHERE number=?')
    .get(cursor)!

  expect(() =>
    nextWorkflowStep(
      'unknown-next-argument',
      'fixture',
      'default',
      { typo: 'value' },
      'invalid close',
      context,
      d,
      {},
      testPorts,
      cursor,
    ),
  ).toThrow(
    `workflow next cursor ${cursor}: workflow "unknown-next-argument" has no argument "typo"; declared arguments: key`,
  )
  expect(
    d
      .query<{ args: string }, [number]>('SELECT args FROM workflow_cursor WHERE number=?')
      .get(cursor),
  ).toEqual(before)
  expect(
    nextWorkflowStep(
      'unknown-next-argument',
      'fixture',
      'default',
      {},
      'valid close',
      context,
      d,
      {},
      testPorts,
      cursor,
      { ruling: 'Proceed.', basis: 'the test fixture', channel: 'mcp' },
    ),
  ).toContain('Rendered after valid next.')
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
