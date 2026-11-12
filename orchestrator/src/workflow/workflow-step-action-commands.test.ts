import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { register as registerPullRequestCommands } from '../commands/pull-request.ts'
import { POST_LANDING_FLAG } from '../pull-request/pr-post-landing-payload.ts'
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
  registerPullRequestCommands(program)
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
  const pr = program.commands.find((command) => command.name() === 'pr')!
  const prCreate = pr.commands.find((command) => command.name() === 'create')!
  const prMerge = pr.commands.find((command) => command.name() === 'merge')!
  const publicLongFlags = (command: Command) =>
    command.options.filter((option) => !option.hidden).map((option) => option.long)
  expect(publicLongFlags(create).filter((flag) => flag !== '--cursor')).toEqual(
    publicLongFlags(prCreate),
  )
  expect(publicLongFlags(merge).filter((flag) => flag !== '--cursor')).toEqual(
    publicLongFlags(prMerge),
  )
  expect(merge.options.map((option) => option.flags)).not.toContain(POST_LANDING_FLAG)
})
