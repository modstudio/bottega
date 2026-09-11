// concern: cli
/** Owns the bought CLI grammar. Must not own application behavior. */
import { Command, CommanderError } from 'commander'
import { recordSessionSeen } from './db.ts'
import { register as registerCleanup } from './commands/cleanup.ts'
import { register as registerDocs } from './commands/docs.ts'
import { register as registerGate } from './commands/gate.ts'
import { register as registerHealth } from './commands/health.ts'
import { register as registerInbox } from './commands/inbox.ts'
import { register as registerJudgement } from './commands/judgement.ts'
import { register as registerReview } from './commands/review.ts'
import { register as registerRouting } from './commands/routing.ts'
import { register as registerRunListing } from './commands/run-listing.ts'
import { setRawArgv } from './commands/support.ts'
import { validateCliArgs } from './args.ts'

const legacyVerbs = [
  'init-db', 'migrate', 'reconcile', 'contract', 'mcp', 'workflow', 'lens', 'issue',
  'note', 'do', 'state', 'search', 'tell', 'peek', 'result', 'wait', 'retry',
  'ask-server', 'setup-ask', 'monitor', 'reclaim', 'answer', 'continue', 'close-out',
  'spawns', 'pick', 'pending', 'metric', 'serve', 'epic', 'jobs', 'agent', 'agents',
] as const

export const program = new Command()
  .name('orch')
  .version('0.1.0')
  .exitOverride()
  .configureOutput({
    writeOut: (value) => process.stdout.write(value),
    writeErr: (value) => process.stderr.write(value),
  })
  .allowUnknownOption(false)

registerGate(program)
registerReview(program)
registerDocs(program)
registerRunListing(program)
registerHealth(program)
registerInbox(program)
registerCleanup(program)
registerJudgement(program)
registerRouting(program)

program.addHelpText('after', `\nLegacy commands (migrate in later slices):\n  ${legacyVerbs.join(', ')}\n`)

export async function run(argv: string[]): Promise<number> {
  setRawArgv(argv)
  const readOnly =
    (argv[0] === 'port' && argv[1] === 'import' && argv.includes('--dry-run')) ||
    (argv[0] === 'review' && ['coverage-audit', 'yield'].includes(argv[1] ?? ''))
  if (!readOnly) recordSessionSeen()
  try {
    if (!argv.includes('--help') && !argv.includes('-h') && !argv.includes('--version') && !argv.includes('-V')) {
      try { validateCliArgs(argv) }
      catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        return 2
      }
    }
    await program.parseAsync(['bun', 'orch', ...argv])
    return Number(process.exitCode ?? 0)
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') return 0
      return 2
    }
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}
