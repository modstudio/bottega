// concern: cli
/** Registers extracted logic-verb adapters. Must not own application decisions. */

import type { Command, OptionValues } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { assetPath } from '../../../shared/install-root.ts'
import { agentCommand, agentsCommand } from '../agent/agent-commands.ts'
import { vendorProbeCommand } from '../agent/vendor-probe.ts'
import { serveAsk } from '../ask/ask.ts'
import { setupAskCommand } from '../ask/ask-commands.ts'
import { writeAskServerFailure } from '../ask/ask-failure.ts'
import { checkCommand } from '../check/check-commands.ts'
import { closeOutCommand } from '../close/close-out-command.ts'
import { peekCommand, resultCommand, waitCommand } from '../collect/collection-commands.ts'
import { contractCommand } from '../contract/contract-command.ts'
import { migrateCommand, reconcileCommand } from '../database/database-commands.ts'
import { db } from '../database/db.ts'
import { doCommand, pickPreviewCommand } from '../dispatch/dispatch-cli-service.ts'
import { enforcementCommand } from '../enforcement/enforcement-commands.ts'
import { epicCommand } from '../epic/epic-commands.ts'
import { pendingCommand } from '../evidence/pending-commands.ts'
import { formatPassingGate, passingGateForCommit } from '../gate/gate-passed.ts'
import { architectGateProcessExitCode, runArchitectGate } from '../gate/gate-run.ts'
import { spawnsCommand } from '../health/spawn-commands.ts'
import {
  treeCreateCommand,
  treeOpenCommand,
  treeRemoveCommand,
} from '../hook-tree/tree-commands.ts'
import { jobsCommand } from '../jobs/job-commands.ts'
import { JOBS } from '../jobs/jobs.ts'
import { tellCommand } from '../mailbox/mailbox-commands.ts'
import { mcpCommand } from '../mcp/mcp-commands.ts'
import { readerMcpProxyCommand } from '../mcp/mcp-reader-proxy.ts'
import { metricCommand } from '../metric/metric-commands.ts'
import { monitorCommand } from '../monitor/monitor-commands.ts'
import { relayCommand, waitingCommand } from '../operator/operator-commands.ts'
import { projectAt } from '../project/projects.ts'
import { treeRefreshCommand } from '../recipe/tree-refresh.ts'
import { treeReseedCommand } from '../recipe/tree-reseed.ts'
import { reclaimCommand } from '../reclaim/reclaim-commands.ts'
import {
  fixDefectCommand,
  noteCommand,
  searchCommand,
  stateCommand,
} from '../record/record-commands.ts'
import { continuationFindingsForRun } from '../review/review-continuation-findings.ts'
import {
  REVIEW_COVERAGE,
  REVIEW_LIMITS,
  REVIEW_OVERLAP,
  REVIEW_REPRODUCED,
} from '../review/review-vocabulary.ts'
import { resolveQuestionIdentifier } from '../run/question-identifier.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'
import { answerCommand, continueCommand, retryCommand } from '../run/run-message-commands.ts'
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
import { ORCH_DO_OPTIONS } from './do-options.ts'
import { registerLensCommands } from './lens.ts'

import { collect, log, productArgv, rawArgv, write, writeStdout } from './support.ts'

const localRunId = (input: string | number) => resolveRunIdentifier(db(), input)
const presentation = {
  log,
  error: (...values: unknown[]) => console.error(...values),
  setExitCode: (code: number) => {
    process.exitCode = code
  },
  exit: (code: number): never => process.exit(code),
  now: Date.now,
  printRunId: (id: number) => write(`${id}\n`),
}
const scoreSuffix = (jobName: string) =>
  (JOBS[jobName]?.needs.writesRepo ? ' [drifted|partial|faithful]' : '') +
  (JOBS[jobName]?.findings
    ? ` [--reproduced ${REVIEW_REPRODUCED.join('|')}] [--coverage ${REVIEW_COVERAGE.join('|')}] [--limits ${REVIEW_LIMITS.join('|')}] [--overlap ${REVIEW_OVERLAP.join('|')}]`
    : '')
const pairHint = (partner: { id: number; agent: string; reason?: string }) =>
  `pair: run ${partner.id} (${partner.agent}) is comparable (${partner.reason ?? 'same task'}) — record with --better-than ${partner.id} | --worse-than ${partner.id} | --same-as ${partner.id}`
const runFlags = (options: OptionValues) => ({
  detach: Boolean(options.detach),
  follow: Boolean(options.follow),
  quiet: Boolean(options.quiet),
})
const tellByIdentifier = (id: string, command: Command, ping: boolean) =>
  tellCommand(localRunId(id), rawArgv(command).slice(2), ping, presentation)
const relayByIdentifier = (id: string, command: Command, note: string) =>
  relayCommand(localRunId(id), rawArgv(command).slice(2), note, presentation, (question) =>
    resolveQuestionIdentifier(db(), question),
  )
const resultByIdentifier = (id: string, options: OptionValues) =>
  resultCommand(
    db(),
    productArgv('result', [String(localRunId(id))], options),
    scoreSuffix,
    presentation,
  )
const waitByIdentifiers = (ids: string[], options: OptionValues) =>
  waitCommand(
    db(),
    productArgv(
      'wait',
      ids.map((id) => String(localRunId(id))),
      options,
    ),
  )

type LogicDependencies = {
  continuationFindingsForRun?: typeof continuationFindingsForRun
  continueCommandDependencies?: NonNullable<Parameters<typeof continueCommand>[6]>
}

function registerMcpServers(program: Command): void {
  program
    .command('ask-server')
    .allowExcessArguments(false)
    .action(async () => {
      try {
        await serveAsk()
      } catch (error) {
        writeAskServerFailure(error)
        throw error
      }
    })
  program
    .command('mcp-reader-proxy <project> <server> <tree>', { hidden: true })
    .allowExcessArguments(false)
    .action((project: string, server: string, tree: string) =>
      readerMcpProxyCommand(project, server, tree),
    )
}

function epicRegisteredProjectWorkingDirectoryRefusal(): string {
  return `${PLATFORM_SLUG} workflow epic requires a registered project working directory`
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

function registerWorkflowDefinitions({ workflow, output }: WorkflowRegistration): void {
  jsonOption(workflow.command('list').description('list workflow definitions'))
    .allowExcessArguments(false)
    .action((options) => listWorkflowCommand(output(options)))

  jsonOption(
    workflow
      .command('show <workflow>')
      .description('show a workflow definition')
      .option('--version <value>', 'show this workflow version'),
  )
    .allowExcessArguments(false)
    .action((slug, options) =>
      showWorkflowCommand(workflowArgv('show', [slug], options), output(options)),
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
      workflowVersionsCommand(workflowArgv('versions', [slug], options), output(options)),
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
      .command('attach [workflow] [text]')
      .description('attach text to the current workflow step')
      .option('--cursor <value>', 'select this workflow cursor')
      .option('--file <value>', 'read the text from this file instead of stdin')
      .option('--mode <value>', 'select this workflow mode')
      .option('--project <value>', 'select this registered project')
      .option('--arg <value>', 'supply a workflow argument as name=value', collect, []),
  )
    .allowExcessArguments(false)
    .action((slug, text, options) => {
      const args = [slug, text].filter((value): value is string => value !== undefined)
      return attachCommand(workflowArgv('attach', args, options), output(options), handlerOptions)
    })

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
    )
      .allowUnknownOption(true)
      .action((commandArgs, options, command) => {
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

function registerWorkflowCatalogue({ workflow, output }: WorkflowRegistration): void {
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
      showCatalogueCommand(productArgv('catalogue', ['show'], options), output(options)),
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
    .action((options) => catalogueVersionsCommand(output(options)))
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

export function register(program: Command, dependencies: LogicDependencies = {}): void {
  program
    .command('enforcement')
    .option('--project <name>')
    .option('--all')
    .option('--json')
    .allowExcessArguments(false)
    .action((options) =>
      enforcementCommand(options, {
        log,
        error: (...values) => console.error(...values),
        setExitCode: (code) => {
          process.exitCode = code
        },
        cwd: process.cwd,
      }),
    )
  program
    .command('check [kind]')
    .option('--enabled')
    .option('--project <value>')
    .option('--fix')
    .option('--message <file>')
    .option('--range [rev-range]')
    .option('--pr <number-or-url>')
    .option('--report')
    .allowExcessArguments(false)
    .action((kind, options) =>
      checkCommand(productArgv('check', kind ? [kind] : [], options), {
        log,
        setExitCode: (code) => {
          process.exitCode = code
        },
        stdinText: () => Bun.stdin.text(),
        stdinIsTTY: () => process.stdin.isTTY,
        cwd: process.cwd,
      }),
    )
  const tree = program.command('tree')
  tree
    .command('create')
    .requiredOption('--name <text>')
    .option('--key <KEY>')
    .option('--base <ref>')
    .option('--seed <value>')
    .option('--cwd <path>', '', process.cwd())
    .allowExcessArguments(false)
    .action((options) =>
      treeCreateCommand(
        {
          cwd: options.cwd,
          name: options.name,
          key: options.key,
          base: options.base,
          seed: options.seed,
        },
        { writePath: (path) => write(`${path}\n`) },
      ),
    )
  tree
    .command('open <run>')
    .option('--seed <value>')
    .allowExcessArguments(false)
    .action((run, options) => treeOpenCommand(localRunId(run), options.seed, { log }))
  tree
    .command('remove <path>')
    .allowExcessArguments(false)
    .action((path) => treeRemoveCommand(path))
  tree
    .command('refresh <path>')
    .allowExcessArguments(false)
    .action((path) => treeRefreshCommand(path, { log }))
  tree
    .command('reseed [seed]')
    .option('--path <tree>', '', process.cwd())
    .allowExcessArguments(false)
    .action((seed, options) => treeReseedCommand(options.path, seed, { log }))
  program
    .command('migrate')
    .option('--backfill-spec-sha')
    .allowExcessArguments(false)
    .action(() => migrateCommand(presentation))
  program
    .command('reconcile <id>')
    .allowExcessArguments(false)
    .action((id) => reconcileCommand(localRunId(id), presentation))
  program
    .command('contract <job>')
    .allowExcessArguments(false)
    .action((job) => contractCommand(job, { write }))
  program
    .command('mcp [verb]')
    .option('--config')
    .option('--project <value>')
    .allowExcessArguments(false)
    .action((verb, options) =>
      mcpCommand(
        Boolean(options.config),
        verb,
        options.project,
        assetPath('bin', PLATFORM_SLUG),
        presentation,
      ),
    )
  registerWorkflowCommands(program)
  registerLensCommands(program)
  program
    .command('fix-defect [key]')
    .option('--waiting')
    .option('--cwd <path>')
    .option('--json')
    .allowExcessArguments(false)
    .action((key, options) =>
      fixDefectCommand(
        key,
        { waiting: Boolean(options.waiting), json: Boolean(options.json), cwd: options.cwd },
        presentation,
      ),
    )
  program
    .command('note <text>')
    .option('--project <name>')
    .option('--same-as <value>')
    .option('--new')
    .allowExcessArguments(false)
    .action((text, options) =>
      noteCommand(
        text,
        { project: options.project, sameAs: options.sameAs, new: Boolean(options.new) },
        presentation,
      ),
    )
  program
    .command('state')
    .option('--days <value>')
    .allowExcessArguments(false)
    .action((options) => stateCommand(options.days ? Number(options.days) : null, presentation))
  program
    .command('search <query>')
    .option('--limit <value>')
    .option('--full')
    .option('--json')
    .allowExcessArguments(false)
    .action((query, options) =>
      searchCommand(
        query,
        {
          limit: Number(options.limit ?? 20),
          full: Boolean(options.full),
          json: Boolean(options.json),
        },
        presentation,
      ),
    )
  program
    .command('tell <id> [message...]')
    .allowUnknownOption(true)
    .option('--file <value>')
    .option('--ping')
    .action((id, _message, options, command) =>
      tellByIdentifier(id, command, Boolean(options.ping)),
    )
  program
    .command('relay <id>')
    .requiredOption('--note <why>')
    .allowUnknownOption(true)
    .action((id, options, command) => relayByIdentifier(id, command, options.note))
  program
    .command('waiting')
    .option('--json')
    .option('--claim-notifications')
    .allowExcessArguments(false)
    .action((options) =>
      waitingCommand(
        { json: Boolean(options.json), claimNotifications: Boolean(options.claimNotifications) },
        presentation,
      ),
    )
  program
    .command('peek <id>')
    .option('--events <value>')
    .option('--json')
    .allowExcessArguments(false)
    .action((id, options) =>
      peekCommand(
        localRunId(id),
        {
          events: options.events === undefined ? undefined : Number(options.events),
          json: Boolean(options.json),
        },
        presentation,
      ),
    )
  program
    .command('result <id>')
    .option('--quiet')
    .option('--artifacts')
    .allowExcessArguments(false)
    .action((id, options) => resultByIdentifier(id, options))
  program
    .command('wait <ids...>')
    .option('--timeout <value>')
    .action(async (ids, options) => waitByIdentifiers(ids, options))
  program
    .command('retry <id>')
    .option('--agent <value>')
    .option('--model <value>')
    .option('--follow')
    .option('--detach')
    .option('--quiet')
    .allowExcessArguments(false)
    .action((id, options) =>
      retryCommand(
        localRunId(id),
        { agent: options.agent, model: options.model, flags: runFlags(options) },
        presentation,
      ),
    )
  program
    .command('answer <id> [message...]')
    .allowUnknownOption(true)
    .option('--file <value>')
    .option('--follow')
    .option('--detach')
    .option('--quiet')
    .option('--record-only')
    .option('--from-operator')
    .option('--channel <value>')
    .option('--json')
    .action((id, _message, options, command) =>
      answerCommand(
        localRunId(id),
        rawArgv(command).slice(2),
        Boolean(options.recordOnly),
        Boolean(options.json),
        runFlags(options),
        presentation,
      ),
    )
  program
    .command('continue <id> [message...]')
    .allowUnknownOption(true)
    .option('--file <value>')
    .option('--follow')
    .option('--detach')
    .option('--quiet')
    .option('--findings')
    .action((id, _message, options, command) =>
      continueCommand(
        localRunId(id),
        rawArgv(command).slice(2),
        Boolean(options.findings),
        runFlags(options),
        presentation,
        (runId, message) =>
          (dependencies.continuationFindingsForRun ?? continuationFindingsForRun)(
            db(),
            runId,
            message,
          ),
        dependencies.continueCommandDependencies,
      ),
    )
  const doVerb = program.command('do <job> [prompt...]')
  for (const option of ORCH_DO_OPTIONS) {
    if ('name' in option && option.name === 'deliverable')
      doVerb.option(option.flags, '', collect, [])
    else doVerb.option(option.flags)
  }
  doVerb.action((_job, _prompt, _options, command) =>
    doCommand(rawArgv(command), {
      error: console.error,
      printRunId: (id) => write(`${id}\n`),
      cwd: process.cwd,
    }),
  )
  const gate = program.command('gate').description('run or inspect recorded project gates')
  gate
    .command('run')
    .description('run the registered project gate in this checkout and record a gate_execution row')
    .allowExcessArguments(false)
    .action(async () => {
      const result = await runArchitectGate({ write: (chunk) => write(chunk) })
      log(String(result.id))
      presentation.setExitCode(architectGateProcessExitCode(result.exitCode))
    })
  gate
    .command('passed <commit>')
    .description('exit zero when this project has a passing gate recorded for the exact commit')
    .allowExcessArguments(false)
    .action((commit) => {
      const result = passingGateForCommit(commit)
      log(formatPassingGate(result))
      presentation.setExitCode(result.gateId === null ? 1 : 0)
    })
  program
    .command('probe <agent>')
    .description('clear a vendor-quota exclusion once the agent answers')
    .allowExcessArguments(false)
    .action((agent) => vendorProbeCommand(agent, presentation))
  program
    .command('pick <job>')
    .option('--agent <value>')
    .option('--avoid <value>')
    .option('--distinct-from <value>')
    .option('--stack <value>')
    .option('--lens <value>')
    .allowExcessArguments(false)
    .action((job, options) =>
      pickPreviewCommand(productArgv('pick', [job], options), {
        error: console.error,
        log,
        printRunId: (id) => write(`${id}\n`),
        cwd: process.cwd,
      }),
    )
  registerMcpServers(program)
  program
    .command('setup-ask')
    .allowExcessArguments(false)
    .action(async () => {
      const code = await setupAskCommand(presentation)
      if (code) process.exitCode = code
    })
  program
    .command('monitor')
    .option('--limit <value>')
    .option('--ack-notices <value>')
    .option('--backstop')
    .option('--history')
    .option('--lock-holder')
    .option('--notices')
    .option('--skip-board-refresh')
    .option('--json')
    .allowExcessArguments(false)
    .action((options) =>
      monitorCommand(
        {
          ackNotices: options.ackNotices,
          notices: Boolean(options.notices),
          history: Boolean(options.history),
          lockHolder: Boolean(options.lockHolder),
          backstop: Boolean(options.backstop),
          limit: Number(options.limit ?? 20),
          json: Boolean(options.json),
          skipBoardRefresh: Boolean(options.skipBoardRefresh),
        },
        { ...presentation, write: writeStdout },
      ),
    )
  program
    .command('reclaim <kind> [subject]')
    .option('--dry-run')
    .allowExcessArguments(false)
    .action((kind, subject, options) =>
      reclaimCommand(kind, subject, Boolean(options.dryRun), presentation),
    )
  program
    .command('close-out <id>')
    .option('--non-blocking')
    .allowExcessArguments(false)
    .action((id, options) =>
      closeOutCommand(localRunId(id), Boolean(options.nonBlocking), presentation),
    )
  program
    .command('spawns')
    .option('--limit <value>')
    .allowExcessArguments(false)
    .action((options) => spawnsCommand(Number(options.limit ?? 15), presentation))
  program
    .command('pending')
    .allowExcessArguments(false)
    .action(() => pendingCommand(pairHint, presentation))
  program
    .command('metric [action]')
    .option('--days <value>')
    .option('--window <value>')
    .allowExcessArguments(false)
    .action((action, options) =>
      metricCommand(
        {
          collect: action === 'collect',
          days: Number(options.days ?? 30),
          window: Number(options.window ?? 14),
        },
        presentation,
      ),
    )
  program
    .command('epic <key>')
    .option('--json')
    .allowExcessArguments(false)
    .action((key, options) => {
      const project = projectAt(process.cwd())
      if (!project) throw new Error(epicRegisteredProjectWorkingDirectoryRefusal())
      return epicCommand(project.name, key, Boolean(options.json), presentation)
    })
  program
    .command('jobs')
    .option('--json')
    .allowExcessArguments(false)
    .action((options) => jobsCommand(Boolean(options.json), presentation))
  program
    .command('agent [args...]')
    .option('--harness <value>')
    .option('--backend <value>')
    .option('--model <value>')
    .option('--base-url <value>')
    .option('--context-tokens <value>')
    .option('--jobs <value>')
    .option('--prefer <value>')
    .option('--max-concurrent <value>')
    .option('--enabled <value>')
    .option('--reason <value>')
    .option('--json')
    .action((args, options) => agentCommand(productArgv('agent', args, options), presentation))
  program
    .command('agents')
    .option('--json')
    .allowExcessArguments(false)
    .action((options) => agentsCommand(Boolean(options.json), presentation))
}
