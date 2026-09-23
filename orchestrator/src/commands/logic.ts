// concern: cli
/** Registers extracted logic-verb adapters. Must not own application decisions. */

import type { Command, OptionValues } from 'commander'
import { assetPath } from '../../../shared/install-root.ts'
import { agentCommand, agentsCommand } from '../agent/agent-commands.ts'
import { serveAsk } from '../ask/ask.ts'
import { setupAskCommand } from '../ask/ask-commands.ts'
import { closeOutCommand } from '../close/close-out-command.ts'
import { peekCommand, resultCommand, waitCommand } from '../collect/collection-commands.ts'
import { contractCommand } from '../contract/contract-command.ts'
import { migrateCommand, reconcileCommand } from '../database/database-commands.ts'
import { db } from '../database/db.ts'
import { doCommand, pickPreviewCommand } from '../dispatch/dispatch-cli-service.ts'
import { epicCommand } from '../epic/epic-commands.ts'
import { pendingCommand } from '../evidence/pending-commands.ts'
import { spawnsCommand } from '../health/spawn-commands.ts'
import {
  treeCreateCommand,
  treeOpenCommand,
  treeRemoveCommand,
} from '../hook-tree/tree-commands.ts'
import { jobsCommand } from '../jobs/job-commands.ts'
import { JOBS } from '../jobs/jobs.ts'
import { lensCommand } from '../lens/lens-commands.ts'
import { tellCommand } from '../mailbox/mailbox-commands.ts'
import { mcpCommand } from '../mcp/mcp-commands.ts'
import { metricCommand } from '../metric/metric-commands.ts'
import { monitorCommand } from '../monitor/monitor-commands.ts'
import { treeRefreshCommand } from '../recipe/tree-refresh.ts'
import { reclaimCommand } from '../reclaim/reclaim-commands.ts'
import {
  fixDefectCommand,
  noteCommand,
  searchCommand,
  serveCommand,
  stateCommand,
} from '../record/record-commands.ts'
import {
  REVIEW_COVERAGE,
  REVIEW_LIMITS,
  REVIEW_OVERLAP,
  REVIEW_REPRODUCED,
} from '../review/review-vocabulary.ts'
import { answerCommand, continueCommand, retryCommand } from '../run/run-message-commands.ts'
import { workflowCommand } from '../workflow/workflow-commands.ts'
import { ORCH_DO_VALUE_OPTIONS } from './do-options.ts'
import { collect, log, productArgv, rawArgv, write, writeStdout } from './support.ts'

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

export function register(program: Command): void {
  const tree = program.command('tree')
  tree
    .command('create')
    .requiredOption('--name <text>')
    .option('--key <KEY>')
    .option('--base <ref>')
    .option('--cwd <path>', '', process.cwd())
    .allowExcessArguments(false)
    .action((options) =>
      treeCreateCommand(
        { cwd: options.cwd, name: options.name, key: options.key, base: options.base },
        { writePath: (path) => write(`${path}\n`) },
      ),
    )
  tree
    .command('open <run>')
    .option('--seed <value>')
    .allowExcessArguments(false)
    .action((run, options) => treeOpenCommand(Number(run), options.seed, { log }))
  tree
    .command('remove <path>')
    .allowExcessArguments(false)
    .action((path) => treeRemoveCommand(path))
  tree
    .command('refresh <path>')
    .allowExcessArguments(false)
    .action((path) => treeRefreshCommand(path, { log }))
  program
    .command('migrate')
    .option('--backfill-spec-sha')
    .allowExcessArguments(false)
    .action(() => migrateCommand(presentation))
  program
    .command('reconcile <id>')
    .allowExcessArguments(false)
    .action((id) => reconcileCommand(Number(id), presentation))
  program
    .command('contract <job>')
    .allowExcessArguments(false)
    .action((job) => contractCommand(job, { write }))
  program
    .command('mcp')
    .option('--config')
    .allowExcessArguments(false)
    .action((options) =>
      mcpCommand(Boolean(options.config), assetPath('bin', 'orch'), presentation),
    )
  program
    .command('workflow [args...]')
    .option('--version <value>')
    .option('--catalogue-version <value>')
    .option('--file <value>')
    .option('--reason <value>')
    .option('--author <value>')
    .option('--from <value>')
    .option('--mode <value>')
    .option('--project <value>')
    .option('--session <value>')
    .option('--note <value>')
    .option('--question <value>')
    .option('--cwd <value>')
    .option('--check')
    .option('--all')
    .option('--arg <value>', '', collect, [])
    .option('--autonomy <value>', '', collect, [])
    .option('--json')
    .action((args, options) =>
      workflowCommand(productArgv('workflow', args, options), presentation),
    )
  program
    .command('lens [args...]')
    .option('--title <value>')
    .option('--question <value>')
    .option('--excludes <value>')
    .option('--slots <value>')
    .option('--slots-file <value>')
    .option('--enabled <value>')
    .option('--reason <value>')
    .option('--axis <value>')
    .option('--name <value>')
    .option('--body <value>')
    .option('--body-file <value>')
    .option('--json')
    .action((args, options) => lensCommand(productArgv('lens', args, options), presentation))
  program
    .command('fix-defect [key]')
    .option('--waiting')
    .option('--json')
    .allowExcessArguments(false)
    .action((key, options) =>
      fixDefectCommand(
        key,
        { waiting: Boolean(options.waiting), json: Boolean(options.json) },
        presentation,
      ),
    )
  program
    .command('note <text>')
    .option('--same-as <value>')
    .option('--new')
    .allowExcessArguments(false)
    .action((text, options) =>
      noteCommand(
        text,
        { sameAs: options.sameAs ? Number(options.sameAs) : undefined, new: Boolean(options.new) },
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
      tellCommand(Number(id), rawArgv(command).slice(2), Boolean(options.ping), presentation),
    )
  program
    .command('peek <id>')
    .option('--events <value>')
    .option('--json')
    .allowExcessArguments(false)
    .action((id, options) =>
      peekCommand(
        Number(id),
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
    .action((id, options) =>
      resultCommand(db(), productArgv('result', [id], options), scoreSuffix, presentation),
    )
  program
    .command('wait <ids...>')
    .option('--timeout <value>')
    .action(async (ids, options) => waitCommand(db(), productArgv('wait', ids, options)))
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
        Number(id),
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
    .action((id, _message, options, command) =>
      answerCommand(
        Number(id),
        rawArgv(command).slice(2),
        Boolean(options.recordOnly),
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
    .action((id, _message, options, command) =>
      continueCommand(Number(id), rawArgv(command).slice(2), runFlags(options), presentation),
    )
  const doVerb = program.command('do <job> [prompt...]')
  for (const option of ORCH_DO_VALUE_OPTIONS) {
    const placeholder = 'placeholder' in option ? option.placeholder : 'value'
    const flags = `--${option.name} ${option.value === 'required' ? `<${placeholder}>` : `[${placeholder}]`}`
    if (option.name === 'deliverable') doVerb.option(flags, '', collect, [])
    else doVerb.option(flags)
  }
  doVerb
    .option('--carry')
    .option('--quiet')
    .option('--probe')
    .option('--follow')
    .option('--detach')
    .option('--porcelain')
    .option('--no-failover')
    .option('--no-wait-capacity')
    .action((_job, _prompt, _options, command) =>
      doCommand(rawArgv(command), {
        error: console.error,
        printRunId: (id) => write(`${id}\n`),
        cwd: process.cwd,
      }),
    )
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
  program
    .command('ask-server')
    .allowExcessArguments(false)
    .action(() => serveAsk())
  program
    .command('setup-ask')
    .allowExcessArguments(false)
    .action(() =>
      setupAskCommand(
        [
          process.execPath,
          '--no-env-file',
          assetPath('orchestrator', 'src', 'cli', 'orch.ts'),
          'ask-server',
        ],
        presentation,
      ),
    )
  program
    .command('monitor')
    .option('--limit <value>')
    .option('--ack-notices <value>')
    .option('--backstop')
    .option('--history')
    .option('--notices')
    .option('--json')
    .allowExcessArguments(false)
    .action((options) =>
      monitorCommand(
        {
          ackNotices: options.ackNotices,
          notices: Boolean(options.notices),
          history: Boolean(options.history),
          backstop: Boolean(options.backstop),
          limit: Number(options.limit ?? 20),
          json: Boolean(options.json),
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
      closeOutCommand(Number(id), Boolean(options.nonBlocking), presentation),
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
    .command('serve')
    .allowExcessArguments(false)
    .action(() => serveCommand(presentation))
  program
    .command('epic <key>')
    .option('--json')
    .allowExcessArguments(false)
    .action((key, options) => epicCommand(key, Boolean(options.json), presentation))
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
