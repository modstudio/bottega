import { expect, test } from 'bun:test'
import { upsertProject } from '../project/projects.ts'
import { productionStepCatalogue } from './step-catalogue.ts'
import { workflowCommand } from './workflow-commands.ts'
import { promoteWorkflow, setWorkflow } from './workflows.ts'

test('mode-less step command resolves autonomy from the fetched catalogue step', async () => {
  upsertProject({
    name: 'mode-less-step',
    path: '/fixture/mode-less-step',
    stack: 'bun',
    settings: { gate: 'bun run check', trunk: 'main', docs: { protocol: 'orch-docs' } },
  })
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
