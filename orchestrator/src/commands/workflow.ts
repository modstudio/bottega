// concern: cli
/** Registers workflow command adapters. Must not own workflow decisions. */

import type { Command, OptionValues } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'
import {
  abandonCommand,
  attachCommand,
  awaitCommand,
  catalogueVersionsCommand,
  composeCommand,
  cursorsCommand,
  execCommand,
  forkCatalogueCommand,
  forkWorkflowCommand,
  hydrateCommand,
  importCommand,
  listWorkflowCommand,
  nextCommand,
  probeCommand,
  promoteCatalogueCommand,
  promoteWorkflowCommand,
  renderCheckCommand,
  retireCatalogueCommand,
  retireWorkflowCommand,
  ruleCommand,
  setCatalogueCommand,
  setWorkflowCommand,
  showCatalogueCommand,
  showWorkflowCommand,
  stepCommand,
  type WorkflowCommandOptions,
  type WorkflowPresentation,
  workflowPrint,
  workflowVersionsCommand,
} from '../workflow/workflow-commands.ts'
import { collect, log, productArgv, rawArgv } from './support.ts'

const localRunId = (input: string | number) => resolveRunIdentifier(db(), input)
const presentation: WorkflowPresentation = {
  log,
  error: (...values: unknown[]) => console.error(...values),
  setExitCode: (code: number) => {
    process.exitCode = code
  },
}

const jsonOption = (command: Command) => command.option('--json', 'print JSON output')
const reasonOption = (command: Command) =>
  command.option('--reason <value>', 'record why this change is being made')
const authorOption = (command: Command) =>
  command.option('--author <value>', 'record who is making this change')
const workflowArgv = (verb: string, args: string[], options: OptionValues) =>
  productArgv('workflow', [verb, ...args], options)
type WorkflowRegistration = {
  workflow: Command
  workflowPresentation: WorkflowPresentation
  handlerOptions: WorkflowCommandOptions
  output(options: OptionValues): ReturnType<typeof workflowPrint>
}

function workflowRegistration(
  program: Command,
  workflowPresentation: WorkflowPresentation = presentation,
  handlerOptions: WorkflowCommandOptions = {},
): WorkflowRegistration {
  const output = (options: OptionValues) =>
    workflowPrint(Boolean(options.json ?? handlerOptions.json), workflowPresentation)
  const workflow = program
    .command('workflow')
    .description('inspect and operate workflows and their cursors')
    .allowExcessArguments(true)
    .action(() => {
      throw new Error(
        `unknown: ${PLATFORM_SLUG} workflow. Try list | show | set | promote | retire | fork | versions | render-check | compose | step | attach | next | await | rule | abandon | cursors | probe | exec | hydrate | import`,
      )
    })
  return { workflow, workflowPresentation, handlerOptions, output }
}

function registerWorkflowDefinitions({
  workflow,
  output,
  handlerOptions,
}: WorkflowRegistration): void {
  jsonOption(workflow.command('list').description('list workflow definitions'))
    .allowExcessArguments(false)
    .action((options) => listWorkflowCommand(output(options), handlerOptions))

  jsonOption(
    workflow
      .command('show <workflow>')
      .description('show a workflow definition')
      .option('--version <value>', 'show this workflow version'),
  )
    .allowExcessArguments(false)
    .action((slug, options) =>
      showWorkflowCommand(workflowArgv('show', [slug], options), output(options), handlerOptions),
    )

  jsonOption(
    authorOption(
      reasonOption(
        workflow
          .command('set <workflow>')
          .description('create a draft workflow version from a JSON file')
          .option('--file <value>', 'read the workflow definition from this file'),
      ),
    ),
  )
    .allowExcessArguments(false)
    .action((slug, options) =>
      setWorkflowCommand(workflowArgv('set', [slug], options), output(options)),
    )
}

function registerWorkflowVersions({
  workflow,
  workflowPresentation,
  handlerOptions,
  output,
}: WorkflowRegistration): void {
  for (const [verb, description, handler] of [
    ['promote', 'promote a draft workflow version to production', promoteWorkflowCommand],
    ['retire', 'retire a workflow version', retireWorkflowCommand],
  ] as const) {
    jsonOption(
      authorOption(
        reasonOption(workflow.command(`${verb} <workflow> <version>`).description(description)),
      ),
    )
      .allowExcessArguments(false)
      .action((slug, version, options) =>
        handler(workflowArgv(verb, [slug, version], options), output(options)),
      )
  }

  jsonOption(
    authorOption(
      reasonOption(
        workflow
          .command('fork <workflow>')
          .description('fork a workflow into a new draft version')
          .option('--from <value>', 'fork from this version'),
      ),
    ),
  )
    .allowExcessArguments(false)
    .action((slug, options) =>
      forkWorkflowCommand(workflowArgv('fork', [slug], options), output(options)),
    )

  jsonOption(workflow.command('versions <workflow>').description('list versions of a workflow'))
    .allowExcessArguments(false)
    .action((slug, options) =>
      workflowVersionsCommand(
        workflowArgv('versions', [slug], options),
        output(options),
        handlerOptions,
      ),
    )

  jsonOption(
    workflow.command('render-check').description('check every production workflow can render'),
  )
    .allowExcessArguments(false)
    .action((options) => renderCheckCommand(Boolean(options.json), workflowPresentation))
}

function registerWorkflowRendering({
  workflow,
  workflowPresentation,
  output,
}: WorkflowRegistration): void {
  jsonOption(
    workflow
      .command('compose <workflow>')
      .description('compose a workflow for a project and create its cursor when ready')
      .option('--version <value>', 'compose this workflow version')
      .option('--catalogue-version <value>', 'compose with this step catalogue version')
      .option('--mode <value>', 'select this workflow mode')
      .option('--project <value>', 'compose for this registered project')
      .option('--arg <value>', 'supply a workflow argument as name=value', collect, [])
      .option('--autonomy <value>', 'override an autonomy scope', collect, []),
  )
    .allowExcessArguments(false)
    .action((slug, options) => {
      const argv = workflowArgv('compose', [slug], options)
      return composeCommand(argv, Boolean(options.json), output(options), workflowPresentation)
    })

  jsonOption(
    workflow
      .command('step [workflow] [step]')
      .description('render one workflow step by slug or position')
      .option('--version <value>', 'use this workflow version')
      .option('--catalogue-version <value>', 'use this step catalogue version')
      .option('--cursor <value>', 'select this workflow cursor')
      .option('--mode <value>', 'select this workflow mode')
      .option('--project <value>', 'select this registered project')
      .option('--arg <value>', 'supply a workflow argument as name=value', collect, [])
      .option('--autonomy <value>', 'override an autonomy scope', collect, []),
  )
    .allowExcessArguments(false)
    .action((slug, step, options) => {
      const args = [slug, step].filter((value): value is string => value !== undefined)
      return stepCommand(workflowArgv('step', args, options), output(options))
    })
}

function registerWorkflowAdvancement({
  workflow,
  handlerOptions,
  output,
}: WorkflowRegistration): void {
  jsonOption(
    workflow
      .command('attach [workflow]')
      .description('attach text to the current workflow step')
      .option('--cursor <value>', 'select this workflow cursor')
      .option('--file <value>', 'read the text from this file instead of stdin')
      .option('--mode <value>', 'select this workflow mode')
      .option('--project <value>', 'select this registered project')
      .option('--arg <value>', 'supply a workflow argument as name=value', collect, []),
  )
    .allowExcessArguments(false)
    .action((slug, options) =>
      attachCommand(
        workflowArgv('attach', slug === undefined ? [] : [slug], options),
        output(options),
        handlerOptions,
      ),
    )

  jsonOption(
    workflow
      .command('next [workflow]')
      .description('close the current step and advance a workflow cursor')
      .option('--cursor <value>', 'select this workflow cursor')
      .option('--mode <value>', 'select this workflow mode')
      .option('--project <value>', 'select this registered project')
      .option('--note <value>', 'record how the current step was completed')
      .option('--question <value>', 'record the self-ruling question')
      .option('--self-ruling <value>', 'record the self-ruling answer')
      .option('--basis <value>', 'record the basis for a self-ruling')
      .option('--ruling <value>', 'cite a ruling as floor evidence')
      .option('--review <value>', 'cite a review as floor evidence')
      .option('--gate <value>', 'cite a gate as floor evidence')
      .option('--run <value>', 'cite a run as floor evidence')
      .option('--artifact <value>', 'cite an artifact as floor evidence')
      .option('--task <value>', 'cite a task as floor evidence')
      .option('--defer <value>', 'record deferred floor evidence')
      .option('--satisfies <value>', 'cite the floor this evidence satisfies')
      .option('--arg <value>', 'supply a workflow argument as name=value', collect, []),
  )
    .allowExcessArguments(false)
    .action((slug, options) => {
      const resolvedOptions =
        options.run === undefined ? options : { ...options, run: String(localRunId(options.run)) }
      nextCommand(
        workflowArgv('next', slug === undefined ? [] : [slug], resolvedOptions),
        output(options),
      )
    })
}

function registerWorkflowRulings({ workflow, output }: WorkflowRegistration): void {
  jsonOption(
    workflow
      .command('await [workflow]')
      .description('pause a workflow cursor for an external ruling')
      .option('--cursor <value>', 'select this workflow cursor')
      .option('--mode <value>', 'select this workflow mode')
      .option('--project <value>', 'select this registered project')
      .option('--question <value>', 'state the question that needs a ruling')
      .option('--arg <value>', 'supply a workflow argument as name=value', collect, []),
  )
    .allowExcessArguments(false)
    .action((slug, options) =>
      awaitCommand(
        workflowArgv('await', slug === undefined ? [] : [slug], options),
        output(options),
      ),
    )

  jsonOption(
    workflow
      .command('rule [workflow]')
      .description('apply a ruling to a waiting workflow cursor')
      .option('--cursor <value>', 'select this workflow cursor')
      .option('--mode <value>', 'select this workflow mode')
      .option('--project <value>', 'select this registered project')
      .option('--ruling <value>', 'supply the ruling text')
      .option('--from-operator', 'mark the ruling as supplied by the operator')
      .option('--arg <value>', 'supply a workflow argument as name=value', collect, []),
  )
    .allowExcessArguments(false)
    .action((slug, options) =>
      ruleCommand(workflowArgv('rule', slug === undefined ? [] : [slug], options), output(options)),
    )
}

function registerWorkflowCursorAdmin({ workflow, output }: WorkflowRegistration): void {
  jsonOption(
    reasonOption(
      workflow
        .command('abandon [workflow]')
        .description('abandon an open workflow cursor')
        .option('--cursor <value>', 'select this workflow cursor')
        .option('--mode <value>', 'select this workflow mode')
        .option('--project <value>', 'select this registered project')
        .option('--arg <value>', 'supply a workflow argument as name=value', collect, []),
    ),
  )
    .allowExcessArguments(false)
    .action((slug, options) =>
      abandonCommand(
        workflowArgv('abandon', slug === undefined ? [] : [slug], options),
        output(options),
      ),
    )

  jsonOption(
    workflow
      .command('cursors')
      .description('list workflow cursors')
      .option('--session <value>', 'limit cursors to this session')
      .option('--project <value>', 'limit cursors to this registered project')
      .option('--all', 'include closed cursors'),
  )
    .allowExcessArguments(false)
    .action((options) => cursorsCommand(workflowArgv('cursors', [], options), output(options)))
}

function registerWorkflowChildCommands({
  workflow,
  workflowPresentation,
  handlerOptions,
  output,
}: WorkflowRegistration): void {
  for (const [verb, description, handler] of [
    ['probe', 'run and record a workflow probe command', probeCommand],
    ['exec', 'run and record a workflow execution command', execCommand],
  ] as const) {
    jsonOption(
      workflow
        .command(`${verb} [command...]`)
        .description(description)
        .option('--cwd <value>', 'run the child command from this directory'),
    ).action((commandArgs, options, command) => {
      const source = rawArgv(command)
      const separator = source.indexOf('--')
      const argv = [
        'workflow',
        verb,
        ...(separator < 0 ? commandArgs : ['--', ...source.slice(separator + 1)]),
      ]
      return handler(argv, output(options), workflowPresentation, {
        ...handlerOptions,
        cwd: options.cwd ?? handlerOptions.cwd,
        json: options.json === undefined ? handlerOptions.json : Boolean(options.json),
      })
    })
  }
}

function registerWorkflowTreeCommands({
  workflow,
  workflowPresentation,
  output,
}: WorkflowRegistration): void {
  workflow
    .command('hydrate')
    .description('write the production workflow tree into a project worktree')
    .option('--cwd <value>', 'select the project worktree to hydrate')
    .option('--check', 'report drift without writing files')
    .allowExcessArguments(false)
    .action((options) => hydrateCommand(workflowArgv('hydrate', [], options), workflowPresentation))

  jsonOption(
    authorOption(
      reasonOption(
        workflow
          .command('import')
          .description('import a project workflow tree as draft definitions')
          .option('--cwd <value>', 'select the project worktree to import'),
      ),
    ),
  )
    .allowExcessArguments(false)
    .action((options) => importCommand(workflowArgv('import', [], options), output(options)))
}

function registerWorkflowCatalogue({
  workflow,
  output,
  handlerOptions,
}: WorkflowRegistration): void {
  const catalogue = workflow
    .command('catalogue')
    .description('inspect and change the workflow step catalogue')
    .action(() => {
      throw new Error(
        `unknown: ${PLATFORM_SLUG} workflow catalogue. Try show | set | promote | retire | fork | versions`,
      )
    })
  catalogue
    .command('*', { hidden: true })
    .description('refuse an unknown workflow catalogue command')
    .action(() => {
      throw new Error(
        `unknown: ${PLATFORM_SLUG} workflow catalogue. Try show | set | promote | retire | fork | versions`,
      )
    })
  jsonOption(
    catalogue
      .command('show')
      .description('show the workflow step catalogue')
      .option('--version <value>', 'show this catalogue version'),
  )
    .allowExcessArguments(false)
    .action((options) =>
      showCatalogueCommand(
        productArgv('catalogue', ['show'], options),
        output(options),
        handlerOptions,
      ),
    )
  jsonOption(
    authorOption(
      reasonOption(
        catalogue
          .command('set')
          .description('create a draft step catalogue from a JSON file')
          .option('--file <value>', 'read the catalogue definition from this file'),
      ),
    ),
  )
    .allowExcessArguments(false)
    .action((options) =>
      setCatalogueCommand(productArgv('catalogue', ['set'], options), output(options)),
    )
  for (const [verb, description, handler] of [
    ['promote', 'promote a draft step catalogue version to production', promoteCatalogueCommand],
    ['retire', 'retire a step catalogue version', retireCatalogueCommand],
  ] as const) {
    jsonOption(
      authorOption(reasonOption(catalogue.command(`${verb} <version>`).description(description))),
    )
      .allowExcessArguments(false)
      .action((version, options) =>
        handler(productArgv('catalogue', [verb, version], options), output(options)),
      )
  }
  jsonOption(
    authorOption(
      reasonOption(
        catalogue
          .command('fork')
          .description('fork the step catalogue into a new draft version')
          .option('--from <value>', 'fork from this catalogue version'),
      ),
    ),
  )
    .allowExcessArguments(false)
    .action((options) =>
      forkCatalogueCommand(productArgv('catalogue', ['fork'], options), output(options)),
    )
  jsonOption(catalogue.command('versions').description('list step catalogue versions'))
    .allowExcessArguments(false)
    .action((options) => catalogueVersionsCommand(output(options), handlerOptions))
}

export function registerWorkflowCommands(
  program: Command,
  workflowPresentation: WorkflowPresentation = presentation,
  handlerOptions: WorkflowCommandOptions = {},
): void {
  const registration = workflowRegistration(program, workflowPresentation, handlerOptions)
  registerWorkflowDefinitions(registration)
  registerWorkflowVersions(registration)
  registerWorkflowRendering(registration)
  registerWorkflowAdvancement(registration)
  registerWorkflowRulings(registration)
  registerWorkflowCursorAdmin(registration)
  registerWorkflowChildCommands(registration)
  registerWorkflowTreeCommands(registration)
  registerWorkflowCatalogue(registration)
}
