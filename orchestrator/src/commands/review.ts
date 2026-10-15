// concern: cli
/** Registers review and confinement adapters. Must not own their behavior. */
import type { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { workerHarnessName } from '../agent/worker-launch-env.ts'
import { clearConfinement } from '../confinement/confinement-ruling.ts'
import { db } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import {
  calibrationReviewCommand,
  completeReviewCommand,
  coverageAuditReviewCommand,
  listReviewCommand,
  pinsReviewCommand,
  recordReviewCommand,
  showReviewCommand,
  tierReviewCommand,
  triageReviewCommand,
  yieldReviewCommand,
} from '../review/review-commands.ts'
import { amendReviewFindingCommand } from '../review/review-finding-amend-command.ts'
import { restoreReviewFindingsCommand } from '../review/review-finding-restore.ts'
import { recordArchitectReadCommand } from '../review/review-read.ts'
import { recordProjectReviewCommand } from '../review/review-record-command.ts'
import { reviewBudgetCommand } from '../review/review-round-budget.ts'
import { restoreReviewTriageCommand } from '../review/review-triage-restore.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'
import {
  formatConfinementReport,
  parseConfinementJobSelector,
  parseConfinementMcpSelector,
  reportConfinement,
} from '../sandbox/confinement-report.ts'
import { readonlyLensReportInputs } from '../sandbox/sandbox.ts'
import { type CliFlags, log, optionFlags } from './support.ts'

const CLEAR_USAGE = `${PLATFORM_SLUG} review confinement clear <run-id> --writer <text> --note <text> [--tip <current-tip>]`
const REPORT_USAGE = `${PLATFORM_SLUG} review confinement report [--agent <name>] [--job reading|writing|<job>] [--mcp [true|false]] [--json]`

function confinementReportCommand(flags: CliFlags): void {
  const lens = readonlyLensReportInputs(process.env)
  const rows = reportConfinement({
    agents: Object.values(AGENTS).map((agent) => ({
      name: agent.name,
      harness: workerHarnessName(agent),
      enabled: agent.enabled !== false,
      readsRepo: agent.caps.readsRepo,
      writesRepo: agent.caps.writesRepo,
      mcp: agent.caps.mcp,
    })),
    parentEnvNames: Object.keys(process.env),
    sandboxOverride: process.env.ORCH_SANDBOX,
    srtDenyRead: lens.denyRead,
    envFilePaths: lens.envFilePaths,
    keychainPaths: lens.keychainPaths,
    agent: flags.flag('agent'),
    job: parseConfinementJobSelector(flags.flag('job'), JOBS),
    mcp: parseConfinementMcpSelector(flags.has('mcp'), flags.flag('mcp')),
  })
  for (const line of formatConfinementReport(rows, flags.has('json'))) log(line)
}

const reviewPresentation = {
  log,
  usage: (): never => {
    throw new Error(`${PLATFORM_SLUG} review --help`)
  },
}

function reviewArgv(command: Command): string[] {
  return ['review', command.name(), ...command.args]
}

function reviewFlags(command: Command): CliFlags {
  return optionFlags(command.opts())
}

function refuseMisplacedDryRun(flags: CliFlags): void {
  if (flags.has('dry-run')) {
    throw new Error(`--dry-run is only valid for ${PLATFORM_SLUG} review restore-triage`)
  }
}

function dryRunRefusalOption(command: Command): Command {
  return command
    .allowExcessArguments(true)
    .option('--dry-run', 'refuse this verb because dry-run is valid only for review restore-triage')
}

type ReviewPresentation = typeof reviewPresentation
type ReviewHandler = (
  argv: string[],
  flags: CliFlags,
  presentation: ReviewPresentation,
) => void | Promise<void>
type ReviewRunner = (command: Command, handler: ReviewHandler) => void | Promise<void>

function runReviewCommand(
  command: Command,
  handler: ReviewHandler,
  presentation = reviewPresentation,
): void | Promise<void> {
  const flags = reviewFlags(command)
  refuseMisplacedDryRun(flags)
  return handler(reviewArgv(command), flags, presentation)
}

function registerReviewQueries(review: Command, run: ReviewRunner): void {
  dryRunRefusalOption(
    review
      .command('list')
      .description('list recorded reviews and their triage state')
      .option('--project <value>', 'include only reviews for this project')
      .option('--since <value>', 'include reviews recorded at or after this ISO datetime')
      .option('--open', 'include only incomplete reviews')
      .option('--complete', 'include only completed reviews')
      .option('--json', 'write the review rows as JSON'),
  ).action((_options, command) =>
    run(command, (_argv, flags, output) => listReviewCommand(flags, output)),
  )

  dryRunRefusalOption(
    review
      .command('show')
      .description('show one review with its lenses, grading, and findings')
      .argument('[id]', 'local review id')
      .option('--json', 'write the review as JSON'),
  ).action((_id, _options, command) => run(command, showReviewCommand))

  dryRunRefusalOption(
    review
      .command('yield')
      .description('report the measured yield of completed review evidence')
      .option('--project <value>', 'include only evidence for this project')
      .option('--since <value>', 'include evidence recorded at or after this ISO datetime')
      .option('--task <value>', 'include only evidence attributed to this task')
      .option('--key <value>', 'alias for --task')
      .option('--lens <value>', 'include only evidence from this lens')
      .option('--agent <value>', 'include only evidence from this agent')
      .option('--json', 'write the yield report as JSON'),
  ).action((_options, command) =>
    run(command, (_argv, flags, output) => yieldReviewCommand(flags, output)),
  )

  dryRunRefusalOption(
    review
      .command('tier')
      .description('classify review tier and round budget for a branch, run, or range')
      .argument('[target]', 'branch, run id, or from..to range')
      .option('--cwd <value>', 'resolve the target from this project checkout')
      .option('--json', 'write the classification as JSON'),
  ).action((_target, _options, command) => run(command, tierReviewCommand))

  dryRunRefusalOption(
    review
      .command('coverage-audit')
      .description('audit completed reviews whose evidence covered trunk')
      .option('--json', 'write the audit as JSON'),
  ).action((_options, command) =>
    run(command, (_argv, flags, output) => coverageAuditReviewCommand(flags, output)),
  )
}

function registerReviewEvidence(review: Command, run: ReviewRunner): void {
  dryRunRefusalOption(
    review
      .command('record')
      .description('record one review from one or more completed lens runs')
      .argument('[run-id...]', 'run ids containing review-contract output'),
  ).action((_runIds, _options, command) => run(command, recordReviewCommand))

  dryRunRefusalOption(
    review
      .command('triage')
      .description('set the disposition of one finding on an incomplete review')
      .argument('[review-id]', 'local review id')
      .argument('[finding]', 'finding ordinal')
      .argument('[disposition]', 'accepted, modified, rejected, or skipped')
      .option('--category <value>', 'record the rejection category')
      .option('--severity <value>', 'record the triaged severity'),
  ).action((_reviewId, _finding, _disposition, _options, command) =>
    run(command, triageReviewCommand),
  )

  dryRunRefusalOption(
    review
      .command('complete')
      .description('mark a fully triaged review complete')
      .argument('[review-id]', 'local review id'),
  ).action((_reviewId, _options, command) => run(command, completeReviewCommand))

  dryRunRefusalOption(
    review
      .command('pins')
      .description('list or prune the refs that pin reviewed commits')
      .option('--prune', 'delete pins whose reviews are landed or superseded'),
  ).action((_options, command) =>
    run(command, (_argv, flags, output) => pinsReviewCommand(flags, output)),
  )

  dryRunRefusalOption(
    review
      .command('calibration')
      .description('show reviewer precision and grading distributions')
      .argument('[lens]', 'lens id for one calibration cell')
      .argument('[agent]', 'agent name for one calibration cell')
      .argument('[model]', 'model name for one calibration cell')
      .option('--json', 'write calibration evidence as JSON'),
  ).action((_lens, _agent, _model, _options, command) => run(command, calibrationReviewCommand))
}

function registerReviewOperations(review: Command, run: ReviewRunner): void {
  dryRunRefusalOption(
    review
      .command('read')
      .description("record the branch owner's architectural read of the current change")
      .option('--cwd <value>', 'measure the change in this checkout')
      .option('--sha <value>', 'record this branch tip instead of HEAD')
      .option('--note <value>', 'one-line account of the architectural read'),
  ).action((_options, command) =>
    run(command, (argv, flags, output) => recordArchitectReadCommand(argv, flags, output)),
  )

  dryRunRefusalOption(
    review
      .command('budget')
      .description('report branches whose eligible review rounds exceed their tier ceiling')
      .option('--since <value>', 'include reviews at or after this ISO date')
      .option('--json', 'write the budget report as JSON'),
  ).action((_options, command) =>
    run(command, (argv, flags, output) => reviewBudgetCommand(argv, flags, output)),
  )

  dryRunRefusalOption(
    review
      .command('project-record')
      .description("run the project's declared review-record command")
      .argument('[branch]', 'reviewed branch')
      .option('--cwd <value>', 'project worktree in which to run the record command')
      .option('--reason <value>', 'one-line reason for the review record'),
  ).action((branch, _options, command) =>
    run(command, (_argv, flags, output) => {
      if (command.args.length !== 1) {
        throw new Error(
          `${PLATFORM_SLUG} review project-record <branch> --cwd <tree> --reason "<one line>"`,
        )
      }
      recordProjectReviewCommand(branch, flags.flag('cwd'), flags.flag('reason'), output)
    }),
  )

  dryRunRefusalOption(
    review
      .command('amend')
      .description('amend the disposition of a finding on a completed review')
      .argument('[review-id]', 'local review id')
      .argument('[finding]', 'finding ordinal')
      .argument('[disposition]', 'accepted, modified, rejected, or skipped')
      .option('--category <value>', 'record the amended rejection category')
      .option('--severity <value>', 'record the amended triaged severity')
      .option('--reason <value>', 'explain why the completed finding is amended'),
  ).action((_reviewId, _finding, _disposition, _options, command) =>
    run(command, (argv, flags, output) => amendReviewFindingCommand(argv, flags, output)),
  )
}

function registerReviewRestore(
  review: Command,
  run: ReviewRunner,
  presentation: ReviewPresentation,
): void {
  dryRunRefusalOption(
    review
      .command('restore-findings')
      .description('report or restore missing review findings from structured outbox rows')
      .option('--json', 'write the restore report as JSON')
      .option('--write', 'apply the reported finding restores')
      .option('--confirm-restore', 'confirm that finding rows may be restored')
      .option('--confirm-live-store <path>', 'confirm the exact live store path to restore'),
  ).action((_options, command) =>
    run(command, (argv, flags, output) => {
      if (argv.length !== 2) {
        throw new Error(
          `${PLATFORM_SLUG} review restore-findings [--json] [--write --confirm-restore] ` +
            '[--confirm-live-store <path>]',
        )
      }
      restoreReviewFindingsCommand(flags, output)
    }),
  )

  review
    .command('restore-triage')
    .description('restore missing triage on completed-review findings from outbox rows')
    .allowExcessArguments(true)
    .option('--dry-run', 'report triage that would be restored without writing')
    .option('--json', 'write the restore report as JSON')
    .action((_options, command) => {
      const argv = reviewArgv(command)
      if (argv.length !== 2)
        throw new Error(`${PLATFORM_SLUG} review restore-triage [--dry-run] [--json]`)
      restoreReviewTriageCommand(reviewFlags(command), presentation)
    })
}

function registerConfinement(program: Command): void {
  const confinement = program
    .command('confinement')
    .description('inspect or clear review-run confinement findings')
    .enablePositionalOptions()
    .allowExcessArguments(false)
    .action(() => {
      throw new Error(`${CLEAR_USAGE}\n${REPORT_USAGE}`)
    })

  confinement
    .command('clear [run-id]')
    .description('clear one confinement finding with an architect ruling')
    .option('--writer <value>', 'name the writer whose change was inspected')
    .option('--note <value>', 'record the confinement ruling')
    .option('--tip <value>', 'record the current branch tip')
    .allowExcessArguments(false)
    .action((runId: string | undefined, options) => {
      const flags = optionFlags(options)
      const id = runId === undefined ? Number.NaN : resolveRunIdentifier(db(), runId)
      const writer = flags.flag('writer')?.trim()
      const note = flags.flag('note')?.trim()
      if (!id || !writer || !note) throw new Error(CLEAR_USAGE)
      clearConfinement(id, { writer, note, tip: flags.flag('tip')?.trim() ?? null }, { log })
    })

  confinement
    .command('report')
    .description('report the sandbox inputs for eligible review agents')
    .option('--agent <value>', 'include only this agent')
    .option('--job <value>', 'report a reading, writing, or named job')
    .option('--mcp [value]', 'filter by whether MCP access is enabled')
    .option('--json', 'write the report as JSON')
    .allowExcessArguments(false)
    .action((options) => {
      confinementReportCommand(optionFlags(options))
    })
}

export function register(program: Command, presentation = reviewPresentation): void {
  const run: ReviewRunner = (command, handler) => runReviewCommand(command, handler, presentation)
  const review = program
    .command('review')
    .description('inspect, record, triage, and maintain review evidence')
    .allowExcessArguments(true)
    .action(() => {
      const sub = review.args[0]
      throw new Error(
        `unknown: ${PLATFORM_SLUG} review${sub ? ` ${sub}` : ''}. Try tier | record | project-record | triage | complete | calibration | restore-findings | restore-triage`,
      )
    })

  registerReviewQueries(review, run)
  registerReviewEvidence(review, run)
  registerReviewOperations(review, run)
  registerReviewRestore(review, run, presentation)
  registerConfinement(program)
}
