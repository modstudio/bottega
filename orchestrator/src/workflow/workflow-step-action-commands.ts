// concern: cli
/** Registers thin command adapters for actions authorized by the current workflow step. */

import type { Command, OptionValues } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { ORCH_DO_OPTIONS } from '../commands/do-options.ts'
import {
  addPullRequestOptions,
  createPullRequestCommand,
  mergePullRequestCommand,
  PR_CREATE_OPTIONS,
  PR_MERGE_OPTIONS,
} from '../commands/pull-request.ts'
import { productArgv, write } from '../commands/support.ts'
import { doCommand } from '../dispatch/dispatch-cli-service.ts'
import { positive } from './workflow-command-arguments.ts'
import {
  createForStep,
  dispatchForStep,
  mergeForStep,
  type StepActionRead,
  type StepLandCreateOptions,
  type StepLandMergeOptions,
} from './workflow-step-action.ts'

type StepActionCommandPorts = {
  read?: StepActionRead
  dispatch?: typeof doCommand
  create?: typeof createPullRequestCommand
  merge?: typeof mergePullRequestCommand
}

const dispatchPresentation = {
  error: (...values: unknown[]) => console.error(...values),
  printRunId: (id: number) => write(`${id}\n`),
  cwd: process.cwd,
}

const dispatchOptionNames = new Set(['file', 'agent', 'model', 'mcp', 'detach'])

function optionName(option: (typeof ORCH_DO_OPTIONS)[number]): string {
  if ('name' in option) return option.name
  return option.flags.match(/^--([a-z0-9-]+)/)?.[1] ?? option.flags
}

function addDispatchOptions(command: Command): Command {
  for (const option of ORCH_DO_OPTIONS) {
    if (dispatchOptionNames.has(optionName(option)))
      command.option(option.flags, option.description)
  }
  return command
}

const cursorNumber = (value: string) => positive(value, '--cursor')!

export async function dispatchForStepCommand(
  job: string,
  prompt: string[],
  options: OptionValues,
  ports: StepActionCommandPorts = {},
): Promise<void> {
  const { cursor, ...dispatchOptions } = options
  const argv = productArgv('do', [job, ...prompt], dispatchOptions)
  await dispatchForStep(
    { cursor: cursorNumber(String(cursor)), job, argv },
    {
      read: ports.read,
      dispatch: (boundArgv, binding) =>
        (ports.dispatch ?? doCommand)(boundArgv, dispatchPresentation, binding),
    },
  )
}

async function createForStepCommand(
  githubArgs: string[],
  options: StepLandCreateOptions & { cursor: string },
  ports: StepActionCommandPorts = {},
): Promise<void> {
  const { cursor, ...createOptions } = options
  await createForStep(
    { cursor: cursorNumber(cursor), args: [githubArgs, createOptions] },
    {
      read: ports.read,
      create: (args, commandOptions) =>
        (ports.create ?? createPullRequestCommand)(args, commandOptions),
    },
  )
}

async function mergeForStepCommand(
  target: string,
  options: StepLandMergeOptions & { cursor: string },
  ports: StepActionCommandPorts = {},
): Promise<void> {
  const { cursor, ...mergeOptions } = options
  await mergeForStep(
    { cursor: cursorNumber(cursor), args: [target, mergeOptions] },
    {
      read: ports.read,
      merge: (numberOrUrl, commandOptions) =>
        (ports.merge ?? mergePullRequestCommand)(numberOrUrl, commandOptions),
    },
  )
}

export function registerWorkflowStepActionCommands(
  workflow: Command,
  ports: StepActionCommandPorts = {},
): void {
  addDispatchOptions(
    workflow
      .command('dispatch <job> [prompt...]')
      .description('dispatch a job declared by the current workflow step')
      .requiredOption('--cursor <value>', 'select this workflow cursor'),
  )
    .allowExcessArguments(false)
    .action((job, prompt, options) => dispatchForStepCommand(job, prompt, options, ports))

  const land = workflow
    .command('land')
    .description('perform a pull-request action declared by the current workflow step')
    .action(() => {
      throw new Error(`unknown: ${PLATFORM_SLUG} workflow land. Try create | merge`)
    })

  addPullRequestOptions(
    land
      .command('create [githubArgs...]')
      .description('create a pull request when the current step declares pr-create')
      .allowUnknownOption(true)
      .requiredOption('--cursor <value>', 'select this workflow cursor'),
    PR_CREATE_OPTIONS,
  ).action((githubArgs, options) => createForStepCommand(githubArgs, options, ports))

  addPullRequestOptions(
    land
      .command('merge <number-or-url>')
      .description('merge a pull request when the current step declares pr-merge')
      .requiredOption('--cursor <value>', 'select this workflow cursor'),
    PR_MERGE_OPTIONS,
  )
    .allowExcessArguments(false)
    .action((target, options) => mergeForStepCommand(target, options, ports))
}
