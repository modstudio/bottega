// concern: cli
/** Registers review and confinement adapters. Must not own their behavior. */
import type { Command } from 'commander'
import { AGENTS } from '../agent/agent-registry.ts'
import { workerHarnessName } from '../agent/worker-launch-env.ts'
import { clearConfinement } from '../confinement/confinement-ruling.ts'
import { JOBS } from '../jobs/jobs.ts'
import { dispatchReviewCommand } from '../review/review-command-dispatcher.ts'
import {
  formatConfinementReport,
  parseConfinementJobSelector,
  parseConfinementMcpSelector,
  reportConfinement,
} from '../sandbox/confinement-report.ts'
import { type CliFlags, log, optionFlags } from './support.ts'

const CLEAR_USAGE =
  'orch confinement clear <run-id> --writer <text> --note <text> [--tip <current-tip>]'
const REPORT_USAGE =
  'orch confinement report [--agent <name>] [--job reading|writing|<job>] [--mcp [true|false]] [--json]'

function confinementReportCommand(flags: CliFlags): void {
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
    agent: flags.flag('agent'),
    job: parseConfinementJobSelector(flags.flag('job'), JOBS),
    mcp: parseConfinementMcpSelector(flags.has('mcp'), flags.flag('mcp')),
  })
  for (const line of formatConfinementReport(rows, flags.has('json'))) log(line)
}

export function register(program: Command): void {
  program
    .command('review [args...]')
    .option('--project <value>')
    .option('--since <value>')
    .option('--task <value>')
    .option('--key <value>')
    .option('--lens <value>')
    .option('--agent <value>')
    .option('--category <value>')
    .option('--severity <value>')
    .option('--reason <value>')
    .option('--sha <value>')
    .option('--note <value>')
    .option('--open')
    .option('--complete')
    .option('--json')
    .option('--dry-run')
    .option('--prune')
    .option('--write')
    .option('--confirm-restore')
    .option('--confirm-live-store <path>')
    .action(async (args, options) => {
      const argv = ['review', ...args]
      await dispatchReviewCommand(argv[1], argv, optionFlags(options), {
        log,
        usage: (): never => {
          throw new Error('orch review --help')
        },
      })
    })

  program
    .command('confinement [args...]')
    .option('--writer <value>')
    .option('--note <value>')
    .option('--tip <value>')
    .option('--agent <value>')
    .option('--job <value>')
    .option('--mcp [value]')
    .option('--json')
    .action((args, options) => {
      const argv = ['confinement', ...args]
      const flags = optionFlags(options)
      if (argv[1] === 'report') {
        confinementReportCommand(flags)
        return
      }
      if (argv[1] !== 'clear') throw new Error(`${CLEAR_USAGE}\n${REPORT_USAGE}`)
      const id = Number(argv[2])
      const writer = flags.flag('writer')?.trim()
      const note = flags.flag('note')?.trim()
      if (!id || !writer || !note) throw new Error(CLEAR_USAGE)
      clearConfinement(id, { writer, note, tip: flags.flag('tip')?.trim() ?? null }, { log })
    })
}
