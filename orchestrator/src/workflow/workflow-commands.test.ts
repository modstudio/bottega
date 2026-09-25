import { expect, test } from 'bun:test'
import { upsertProject } from '../project/projects.ts'
import { productionStepCatalogue } from './step-catalogue.ts'
import { workflowCommand } from './workflow-commands.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { promoteWorkflow, setWorkflow, type WorkflowDefinition } from './workflows.ts'

const presentation = (lines: string[]) => ({
  log: (line: string) => lines.push(line),
  setExitCode: () => {},
})

const registerFixtureProject = (name: string) =>
  upsertProject({
    name,
    path: `/fixture/${name}`,
    stack: 'bun',
    settings: { gate: 'bun run check', trunk: 'main', docs: { protocol: 'orch-docs' } },
  })

const publishCursorWorkflow = (slug: string, modes: WorkflowDefinition['modes']) => {
  const draft = setWorkflow(
    slug,
    {
      title: `Cursor command ${slug}`,
      description: 'Exercises cursor mode resolution.',
      arguments: [{ name: 'key', required: true, description: 'Task key.' }],
      modes,
    },
    'test cursor mode resolution',
    'test',
  )
  promoteWorkflow(slug, draft.n, 'publish', 'test')
}

test('mode-less step command resolves autonomy from the fetched catalogue step', async () => {
  registerFixtureProject('mode-less-step')
  const step = productionStepCatalogue().definition.steps.find(({ slug }) => slug === 'complete')!
  const draft = setWorkflow(
    'mode-less-step',
    {
      title: 'Mode-less step',
      description: 'Exercises the command without a workflow default mode.',
      arguments: [],
      modes: [{ slug: 'only', title: 'Only', entry: 'Use the only mode?', steps: [step.slug] }],
    },
    'test mode-less step command',
    'test',
  )
  promoteWorkflow('mode-less-step', draft.n, 'publish', 'test')
  const lines: string[] = []

  await workflowCommand(
    ['workflow', 'step', 'mode-less-step', step.slug, '--project', 'mode-less-step'],
    {
      log: (line) => lines.push(line),
      setExitCode: () => {},
    },
  )

  expect(lines.join('\n')).toContain(`Autonomy: ${step.autonomy} (built-in)`)
})

test('next resolves an omitted mode to the composed cursor default', async () => {
  const slug = 'cursor-default-next'
  const project = 'cursor-default-next-project'
  const step = productionStepCatalogue().definition.steps.find(({ slug }) => slug === 'complete')!
  registerFixtureProject(project)
  publishCursorWorkflow(slug, [
    { slug: 'report', title: 'Report', default: true, steps: [step.slug] },
  ])
  composeWorkflowWithCursor(slug, project, undefined, { key: 'DEV-937-default' }, {})
  const lines: string[] = []

  await workflowCommand(
    [
      'workflow',
      'next',
      slug,
      '--project',
      project,
      '--arg',
      'key=DEV-937-default',
      '--note',
      'completed the report',
    ],
    presentation(lines),
  )

  expect(lines.join('\n')).toContain(`Workflow ${slug} for DEV-937-default is finished`)
})

test('cursor command without a default mode names the available modes', async () => {
  const slug = 'cursor-no-default'
  const project = 'cursor-no-default-project'
  const step = productionStepCatalogue().definition.steps.find(({ slug }) => slug === 'complete')!
  registerFixtureProject(project)
  publishCursorWorkflow(slug, [
    { slug: 'report', title: 'Report', entry: 'Prepare a report?', steps: [step.slug] },
    { slug: 'repair', title: 'Repair', entry: 'Make a repair?', steps: [step.slug] },
  ])

  expect(
    workflowCommand(
      ['workflow', 'next', slug, '--project', project, '--arg', 'key=DEV-937-no-default'],
      presentation([]),
    ),
  ).rejects.toThrow(
    `orch workflow next cannot resolve a default mode for workflow "${slug}"; modes: report, repair; pass --mode <slug>`,
  )
})

test('next preserves an explicit mode', async () => {
  const slug = 'cursor-explicit-next'
  const project = 'cursor-explicit-next-project'
  const step = productionStepCatalogue().definition.steps.find(({ slug }) => slug === 'complete')!
  registerFixtureProject(project)
  publishCursorWorkflow(slug, [
    { slug: 'report', title: 'Report', default: true, steps: [step.slug] },
    { slug: 'repair', title: 'Repair', steps: [step.slug] },
  ])
  composeWorkflowWithCursor(slug, project, 'repair', { key: 'DEV-937-explicit' }, {})
  const lines: string[] = []

  await workflowCommand(
    [
      'workflow',
      'next',
      slug,
      '--project',
      project,
      '--mode',
      'repair',
      '--arg',
      'key=DEV-937-explicit',
      '--note',
      'completed the repair',
    ],
    presentation(lines),
  )

  expect(lines.join('\n')).toContain(`Workflow ${slug} for DEV-937-explicit is finished`)
})

test('mode-less cursor verbs keep using the cursor mode after the workflow default changes', async () => {
  const slug = 'cursor-pinned-default'
  const project = 'cursor-pinned-default-project'
  const key = 'DEV-937-pinned'
  const catalogue = productionStepCatalogue().definition.steps
  const steps = [
    catalogue.find(({ slug }) => slug === 'complete')!.slug,
    catalogue.find(({ slug }) => slug === 'score')!.slug,
  ]
  registerFixtureProject(project)
  publishCursorWorkflow(slug, [
    { slug: 'report', title: 'Report', default: true, steps },
    { slug: 'repair', title: 'Repair', steps },
  ])
  composeWorkflowWithCursor(slug, project, undefined, { key }, {})
  const changed = setWorkflow(
    slug,
    {
      title: `Cursor command ${slug}`,
      description: 'Exercises pinned cursor mode resolution.',
      arguments: [{ name: 'key', required: true, description: 'Task key.' }],
      modes: [
        { slug: 'report', title: 'Report', steps },
        { slug: 'repair', title: 'Repair', default: true, steps },
      ],
    },
    'change the default mode',
    'test',
  )
  promoteWorkflow(slug, changed.n, 'publish changed default', 'test')
  const lines: string[] = []
  const command = (verb: string, ...tail: string[]) =>
    workflowCommand(
      ['workflow', verb, slug, '--project', project, '--arg', `key=${key}`, ...tail],
      presentation(lines),
    )

  await command('next', '--note', 'completed the report')
  await command('await', '--question', 'which ruling applies?')
  await command('abandon', '--reason', 'operator stopped')

  expect(lines.join('\n')).toContain(`workflow ${slug} is awaiting a ruling at step 2 score`)
  expect(lines.join('\n')).toContain(`Workflow ${slug} for ${key} was abandoned at step 2 score`)
})

test('mode-less cursor command refuses active cursors in multiple modes', async () => {
  const slug = 'cursor-ambiguous-mode'
  const project = 'cursor-ambiguous-mode-project'
  const key = 'DEV-937-ambiguous'
  const step = productionStepCatalogue().definition.steps.find(({ slug }) => slug === 'complete')!
  registerFixtureProject(project)
  publishCursorWorkflow(slug, [
    { slug: 'report', title: 'Report', default: true, steps: [step.slug] },
    { slug: 'repair', title: 'Repair', steps: [step.slug] },
  ])
  composeWorkflowWithCursor(slug, project, 'report', { key }, {})
  composeWorkflowWithCursor(slug, project, 'repair', { key }, {})

  expect(
    workflowCommand(
      ['workflow', 'next', slug, '--project', project, '--arg', `key=${key}`],
      presentation([]),
    ),
  ).rejects.toThrow(
    `orch workflow next cannot resolve a mode for workflow "${slug}"; ` +
      'active cursor modes: repair, report; pass --mode <slug>',
  )
})
