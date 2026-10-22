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
import { provisioningCommand } from '../monitor/provisioning-commands.ts'
import { storageCommand } from '../monitor/storage-commands.ts'
import { relayCommand, waitingCommand } from '../operator/operator-commands.ts'
import { projectAt } from '../project/projects.ts'
import { treeRefreshCommand } from '../recipe/tree-refresh.ts'
import { treeReseedCommand } from '../recipe/tree-reseed.ts'
import { reclaimCommand } from '../reclaim/reclaim-commands.ts'
import { fixDefectCommand, searchCommand, stateCommand } from '../record/record-commands.ts'
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
import { loadSubscriptionCostContext } from '../run/run-subscription-prices.ts'
import { formatShipCleanup, shipCleanup } from '../ship-cleanup/ship-cleanup.ts'
import { SHIP_CLEANUP_RESIDUE_EXIT_CODE } from '../ship-cleanup/ship-cleanup-decision.ts'
import { ORCH_DO_OPTIONS } from './do-options.ts'
import { registerLensCommands } from './lens.ts'
import { collect, log, productArgv, rawArgv, write, writeStdout } from './support.ts'
import { registerWorkflowCommands } from './workflow.ts'

const localRunId = (input: string | number) => resolveRunIdentifier(db(), input)
const displayRunNumber = (recordId: string): number =>
  (db().query('SELECT number FROM run WHERE record_id=?').get(recordId) as { number: number })
    .number
const presentation = {
  log,
  error: (...values: unknown[]) => console.error(...values),
  setExitCode: (code: number) => {
    process.exitCode = code
  },
  exit: (code: number): never => process.exit(code),
  now: Date.now,
  printRunId: (id: string) => write(`${displayRunNumber(id)}\n`),
}
const scoreSuffix = (jobName: string) =>
  (JOBS[jobName]?.needs.writesRepo ? ' [drifted|partial|faithful]' : '') +
  (JOBS[jobName]?.findings
    ? ` [--reproduced ${REVIEW_REPRODUCED.join('|')}] [--coverage ${REVIEW_COVERAGE.join('|')}] [--limits ${REVIEW_LIMITS.join('|')}] [--overlap ${REVIEW_OVERLAP.join('|')}]`
    : '')
const pairHint = (partner: { id: string; agent: string; reason?: string }) => {
  const number = displayRunNumber(partner.id)
  return `pair: run ${number} (${partner.agent}) is comparable (${partner.reason ?? 'same task'}) — record with --better-than ${number} | --worse-than ${number} | --same-as ${number}`
}
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

const TREE_DESCRIPTIONS = {
  create: 'create a project worktree and print its path',
  open: 'open an architect-owned worktree on a finished run branch',
  remove: 'release an architect-owned worktree',
  refresh: 'fast-forward a clean worktree and refresh its provisions',
  reseed: 'replace a worktree seed and its provisions',
} as const

function registerMcpServers(program: Command): void {
  program
    .command('ask-server')
    .description('serve the worker question channel')
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

const describedCommand = (program: Command, name: string, description: string) =>
  program.command(name).description(description)

function answerCommandDefinition(program: Command): Command {
  return describedCommand(
    program,
    'answer <id> [message...]',
    'record rulings for a worker and resume its run',
  )
    .allowUnknownOption(true)
    .option('--file <value>', 'read the ruling from this file')
    .option('--follow', 'wait for the resumed run and print its result')
    .option('--detach', 'return after resuming the run')
    .option('--quiet', 'suppress collection guidance and followed output')
    .option('--record-only', 'record the ruling without resuming the run')
    .option('--from-operator', 'attribute the ruling to the operator')
    .option('--from-operator-q<id>', 'attribute only question <id> to the operator')
    .option('--channel <value>', 'record the channel that supplied the ruling')
    .option('--json', 'write the answer result as JSON')
}

function registerMachineAttentionCommands(program: Command): void {
  program
    .command('provisioning')
    .description('report worker-tree provisioning cost or run resources')
    .option('--project <name>', 'limit samples to one project')
    .option('--since <duration>', 'limit samples by age')
    .option('--resources', 'report run CPU time and peak memory instead')
    .option('--json', 'write the report as JSON')
    .allowExcessArguments(false)
    .action((options) =>
      provisioningCommand(
        {
          project: options.project,
          since: options.since,
          json: Boolean(options.json),
          resources: Boolean(options.resources),
        },
        { write: writeStdout },
      ),
    )
  program
    .command('setup-ask')
    .description('install the live worker question channel')
    .allowExcessArguments(false)
    .action(async () => {
      const code = await setupAskCommand(presentation)
      if (code) process.exitCode = code
    })
  program
    .command('monitor')
    .description('inspect machine conditions that need attention')
    .option('--limit <value>', 'maximum monitor history rows to list')
    .option('--ack-notices <value>', 'comma-separated notice identifiers to acknowledge')
    .option('--backstop', 'record the monitor pass as a scheduled backstop')
    .option('--history', 'list recorded monitor passes')
    .option('--lock-holder', 'show the process holding the orchestrator store write lock')
    .option('--notices', 'claim undelivered monitor notices for this session')
    .option('--skip-board-refresh', 'claim notices without refreshing the board')
    .option('--json', 'write the monitor result as JSON')
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
    .command('storage')
    .description('measure run, worktree, store, and volume storage')
    .option('--json', 'write the storage report as JSON')
    .allowExcessArguments(false)
    .action((options) => storageCommand(Boolean(options.json), { write: writeStdout }))
  program
    .command('reclaim <kind> [subject]')
    .description('reclaim one classified stale resource')
    .option('--dry-run', 'report the reclamation without applying it')
    .allowExcessArguments(false)
    .action(async (kind, subject, options) =>
      reclaimCommand(kind, subject, Boolean(options.dryRun), presentation),
    )
}

function registerTreeCommands(program: Command): void {
  const tree = program.command('tree').description('create, refresh, and release worktrees')
  tree
    .command('create')
    .description(TREE_DESCRIPTIONS.create)
    .requiredOption('--name <text>', 'name the worktree')
    .option('--key <KEY>', 'attribute the worktree to this task')
    .option('--base <ref>', 'create the worktree from this revision')
    .option('--seed <value>', 'provision the worktree from this project seed')
    .option('--cwd <path>', 'select the project from this working directory', process.cwd())
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
    .description(TREE_DESCRIPTIONS.open)
    .option('--seed <value>', 'provision the worktree from this project seed')
    .allowExcessArguments(false)
    .action((run, options) => treeOpenCommand(localRunId(run), options.seed, { log }))
  tree
    .command('remove <path>')
    .description(TREE_DESCRIPTIONS.remove)
    .allowExcessArguments(false)
    .action((path) => treeRemoveCommand(path))
  tree
    .command('refresh <path>')
    .description(TREE_DESCRIPTIONS.refresh)
    .allowExcessArguments(false)
    .action((path) => treeRefreshCommand(path, { log }))
  tree
    .command('reseed [seed]')
    .description(TREE_DESCRIPTIONS.reseed)
    .option('--path <tree>', 'select the worktree to reseed', process.cwd())
    .allowExcessArguments(false)
    .action((seed, options) => treeReseedCommand(options.path, seed, { log }))
  tree
    .command('ship-cleanup <branch>')
    .description('remove ephemeral resources for a landed branch')
    .allowExcessArguments(false)
    .action((branch) => {
      const report = shipCleanup(branch)
      log(formatShipCleanup(report))
      if (!report.verdict.clean) process.exitCode = SHIP_CLEANUP_RESIDUE_EXIT_CODE
    })
}

function registerAgentCommands(program: Command): void {
  describedCommand(program, 'agent [args...]', 'inspect and change agent registrations')
    .option('--harness <value>', 'set the agent harness')
    .option('--backend <value>', 'set the model backend')
    .option('--model <value>', 'set the model identifier')
    .option('--base-url <value>', 'set the model endpoint URL')
    .option('--api-key-secret <value>', 'set the sealed key holding the endpoint API key')
    .option('--clear-api-key-secret', 'clear the endpoint API key reference')
    .option('--context-tokens <value>', 'set the served context window')
    .option('--billing <value>', 'set the billing class')
    .option(
      '--route-metered <value>',
      "allow automatic read-only routing to this metered agent; spend limits live in the provider key's own settings",
    )
    .option('--jobs <value>', 'allow these comma-separated jobs or any')
    .option('--prefer <value>', 'prefer these comma-separated jobs')
    .option('--max-concurrent <value>', 'limit concurrent runs for this agent')
    .option('--enabled <value>', 'enable or disable the agent')
    .option('--reason <value>', 'record why the agent is disabled')
    .option('--json', 'write the agent listing as JSON')
    .action((args, options) => agentCommand(productArgv('agent', args, options), presentation))
}

async function epicAction(
  key: string,
  json: boolean,
  presentation: { log(value: string): void },
): Promise<void> {
  const project = projectAt(process.cwd())
  if (!project) throw new Error(epicRegisteredProjectWorkingDirectoryRefusal())
  await epicCommand(project.name, key, json, presentation, {
    subscriptionCost: await loadSubscriptionCostContext(),
  })
}

export function register(program: Command, dependencies: LogicDependencies = {}): void {
  program
    .command('enforcement')
    .description('show the mechanical checks resolved for registered projects')
    .option('--project <name>', 'registered project to inspect')
    .option('--all', 'inspect every registered project')
    .option('--json', 'write the enforcement report as JSON')
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
    .description('run a project spelling, attribution, or comment check')
    .option('--enabled', 'run every check enabled for the project')
    .option('--project <value>', 'registered project to check')
    .option('--fix', 'write spelling corrections')
    .option('--message <file>', 'file containing the commit message to check')
    .option('--range [rev-range]', 'Git revision range whose commits are checked')
    .option('--pr <number-or-url>', 'pull request number or URL to check')
    .option('--report', 'report comment findings without refusing them')
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
  registerTreeCommands(program)
  program
    .command('migrate')
    .description('apply pending orchestrator store migrations')
    .option('--backfill-spec-sha', 'backfill missing run specification hashes')
    .allowExcessArguments(false)
    .action(() => migrateCommand(presentation))
  describedCommand(program, 'reconcile <id>', 'reconcile a completed run with its saved artifacts')
    .allowExcessArguments(false)
    .action((id) => reconcileCommand(localRunId(id), presentation))
  describedCommand(program, 'contract <job>', 'print the worker reply contract for a job')
    .allowExcessArguments(false)
    .action((job) => contractCommand(job, { write }))
  program
    .command('mcp [verb]')
    .description('serve an orchestrator model-context-protocol endpoint')
    .option('--config', 'print the server configuration instead of serving')
    .option('--project <value>', 'project exposed by the server')
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
    .option('--waiting', 'list filed defect issues waiting in the queue')
    .option('--cwd <path>', 'resolve the waiting queue from this project checkout')
    .option('--json', 'write the waiting queue as JSON')
    .allowExcessArguments(false)
    .action((key, options) =>
      fixDefectCommand(
        key,
        { waiting: Boolean(options.waiting), json: Boolean(options.json), cwd: options.cwd },
        presentation,
      ),
    )
  describedCommand(program, 'state', 'print the orchestrator state as JSON')
    .option('--days <value>', 'limit history to this many days')
    .allowExcessArguments(false)
    .action((options) => stateCommand(options.days ? Number(options.days) : null, presentation))
  describedCommand(program, 'search <query>', 'search saved run prompts, replies, and notes')
    .option('--limit <value>', 'limit the number of matches')
    .option('--full', 'print complete matching content')
    .option('--json', 'write the search results as JSON')
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
  describedCommand(program, 'tell <id> [message...]', 'queue a message for a running worker')
    .allowUnknownOption(true)
    .option('--file <value>', 'read the message from this file')
    .option('--ping', 'print the run state after queuing the message')
    .action((id, _message, options, command) =>
      tellByIdentifier(id, command, Boolean(options.ping)),
    )
  describedCommand(program, 'relay <id>', 'relay a worker question to the operator')
    .requiredOption('--note <why>', 'record why the question needs the operator')
    .allowUnknownOption(true)
    .action((id, options, command) => relayByIdentifier(id, command, options.note))
  describedCommand(program, 'waiting', 'list questions waiting on the operator')
    .option('--json', 'write the waiting questions as JSON')
    .option('--claim-notifications', 'claim and include pending operator notifications')
    .allowExcessArguments(false)
    .action((options) =>
      waitingCommand(
        { json: Boolean(options.json), claimNotifications: Boolean(options.claimNotifications) },
        presentation,
      ),
    )
  describedCommand(program, 'peek <id>', 'show a run summary and its recent events')
    .option('--events <value>', 'include this many recent events')
    .option('--json', 'write the run summary as JSON')
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
  describedCommand(program, 'result <id>', 'collect a finished run result')
    .option('--quiet', 'suppress status guidance')
    .option('--artifacts', 'print the run artifact manifest')
    .allowExcessArguments(false)
    .action((id, options) => resultByIdentifier(id, options))
  describedCommand(program, 'wait <ids...>', 'wait for runs to reach a terminal state')
    .option('--timeout <value>', 'stop waiting after this duration')
    .action(async (ids, options) => waitByIdentifiers(ids, options))
  describedCommand(program, 'retry <id>', 'retry a failed run with its saved prompt')
    .option('--agent <value>', 'use this agent for the retry')
    .option('--model <value>', 'use this model for the retry')
    .option('--follow', 'wait for the retry and print its result')
    .option('--detach', 'return after starting the retry')
    .option('--quiet', 'suppress collection guidance and followed output')
    .allowExcessArguments(false)
    .action((id, options) =>
      retryCommand(
        localRunId(id),
        { agent: options.agent, model: options.model, flags: runFlags(options) },
        presentation,
      ),
    )
  answerCommandDefinition(program).action((id, _message, options, command) =>
    answerCommand(
      localRunId(id),
      rawArgv(command).slice(2),
      Boolean(options.recordOnly),
      Boolean(options.json),
      runFlags(options),
      presentation,
    ),
  )
  describedCommand(program, 'continue <id> [message...]', 'continue a finished run as another turn')
    .allowUnknownOption(true)
    .option('--file <value>', 'read the continuation message from this file')
    .option('--follow', 'wait for the continuation and print its result')
    .option('--detach', 'return after starting the continuation')
    .option('--quiet', 'suppress collection guidance and followed output')
    .option('--findings', 'include prior review findings in the continuation')
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
  const doVerb = describedCommand(
    program,
    'do <job> [prompt...]',
    'dispatch a job to a routed agent',
  )
  for (const option of ORCH_DO_OPTIONS) {
    if ('name' in option && option.name === 'deliverable')
      doVerb.option(option.flags, option.description, collect, [])
    else doVerb.option(option.flags, option.description)
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
  describedCommand(program, 'pick <job>', 'preview the agent selected for a job')
    .option('--agent <value>', 'select this agent if it is eligible')
    .option('--avoid <value>', 'exclude this agent from the preview')
    .option('--distinct-from <value>', 'exclude the model used by this run')
    .option('--stack <value>', 'evaluate routing for this project stack')
    .option('--lens <value>', 'evaluate routing for this review lens')
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
  registerMachineAttentionCommands(program)
  describedCommand(program, 'close-out <id>', 'release a terminal run worktree and its claims')
    .option('--non-blocking', 'refuse instead of waiting for the cleanup lock')
    .allowExcessArguments(false)
    .action((id, options) =>
      closeOutCommand(localRunId(id), Boolean(options.nonBlocking), presentation),
    )
  describedCommand(program, 'spawns', 'report subagent spawn-gate decisions')
    .option('--limit <value>', 'show this many recent spawn decisions')
    .allowExcessArguments(false)
    .action((options) => spawnsCommand(Number(options.limit ?? 15), presentation))
  describedCommand(program, 'pending', 'list your runs awaiting verdicts or comparisons')
    .allowExcessArguments(false)
    .action(() => pendingCommand(pairHint, presentation))
  describedCommand(program, 'metric [action]', 'collect or report orchestration efficiency metrics')
    .option('--days <value>', 'collect this many days of metric inputs')
    .option('--window <value>', 'report metrics over this many days')
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
    .option('--json', 'write the scoreboard as JSON')
    .allowExcessArguments(false)
    .action((key, options) => epicAction(key, Boolean(options.json), presentation))
  describedCommand(program, 'jobs', 'list jobs and their capability requirements')
    .option('--json', 'write the job catalogue as JSON')
    .allowExcessArguments(false)
    .action((options) => jobsCommand(Boolean(options.json), presentation))
  registerAgentCommands(program)
  describedCommand(program, 'agents', 'list agents and their readiness')
    .option('--json', 'write agent capabilities as JSON')
    .allowExcessArguments(false)
    .action((options) => agentsCommand(Boolean(options.json), presentation))
}
