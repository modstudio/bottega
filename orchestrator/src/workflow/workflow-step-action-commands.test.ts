import { expect, test } from 'bun:test'
import { Command } from 'commander'
import {
  dispatchForStepCommand,
  registerWorkflowStepActionCommands,
} from './workflow-step-action-commands.ts'

test('workflow dispatch preserves its allowed run-start inputs and adds the cursor binding', async () => {
  const calls: unknown[][] = []
  await dispatchForStepCommand(
    'implement',
    ['Build', 'it.'],
    {
      cursor: '9',
      file: 'spec.md',
      agent: 'codex',
      model: 'gpt-test',
      mcp: 'prefer',
      detach: true,
    },
    {
      read: async () => ({
        cursor: 9,
        cursorRecordId: 'cursor-record-9',
        stepSlug: 'implement',
        taskKey: 'DEV-2283',
        jobs: ['implement'],
        actions: [],
      }),
      dispatch: async (...args) => {
        calls.push(args)
      },
    },
  )
  expect(calls).toEqual([
    [
      [
        'do',
        'implement',
        'Build',
        'it.',
        '--file',
        'spec.md',
        '--agent',
        'codex',
        '--model',
        'gpt-test',
        '--mcp',
        'prefer',
        '--detach',
        '--key',
        'DEV-2283',
      ],
      expect.any(Object),
      { cursorRecordId: 'cursor-record-9', stepSlug: 'implement' },
    ],
  ])
})

test('workflow step action surfaces expose only the ruled public options', () => {
  const program = new Command()
  const workflow = program.command('workflow')
  registerWorkflowStepActionCommands(workflow)
  const dispatch = workflow.commands.find((command) => command.name() === 'dispatch')!
  expect(dispatch.options.map((option) => option.long)).toEqual([
    '--cursor',
    '--agent',
    '--file',
    '--model',
    '--detach',
    '--mcp',
  ])
  const land = workflow.commands.find((command) => command.name() === 'land')!
  const create = land.commands.find((command) => command.name() === 'create')!
  const merge = land.commands.find((command) => command.name() === 'merge')!
  expect(create.options.map((option) => option.long)).toEqual([
    '--cursor',
    '--cwd',
    '--override-triage',
    '--ceiling-ruling',
    '--from-operator',
  ])
  expect(merge.options.map((option) => option.long)).toEqual([
    '--cursor',
    '--cwd',
    '--release-required',
    '--depth',
  ])
})
