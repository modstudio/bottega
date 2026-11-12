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

test('workflow land forwards create and merge options without the cursor', async () => {
  const creates: unknown[][] = []
  const merges: unknown[][] = []
  const program = new Command()
  const workflow = program.command('workflow')
  registerWorkflowStepActionCommands(workflow, {
    read: async () => ({
      cursor: 7,
      cursorRecordId: 'cursor-record-7',
      stepSlug: 'land',
      taskKey: 'DEV-2283',
      jobs: [],
      actions: ['pr-create', 'pr-merge'],
    }),
    create: async (...args) => {
      creates.push(args)
    },
    merge: async (...args) => {
      merges.push(args)
    },
  })

  await program.parseAsync([
    'node',
    'orch',
    'workflow',
    'land',
    'merge',
    '42',
    '--cursor',
    '7',
    '--release-required',
    '--depth',
    'hosted-api',
  ])
  expect(merges).toEqual([['42', { releaseRequired: true, depth: 'hosted-api' }]])
  expect(merges[0]![1]).not.toHaveProperty('cursor')

  await program.parseAsync([
    'node',
    'orch',
    'workflow',
    'land',
    'create',
    '--cursor',
    '7',
    '--override-triage',
    'why',
    '--from-operator',
    '--title',
    'T',
  ])
  expect(creates).toEqual([[['--title', 'T'], { overrideTriage: 'why', fromOperator: true }]])
  expect(creates[0]![1]).not.toHaveProperty('cursor')
})
