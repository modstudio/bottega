// concern: cli
/** Owns the bought CLI grammar. Must not own application behavior. */
import { Command, CommanderError } from 'commander'
import { register as registerBranches } from '../commands/branches.ts'
import { register as registerCleanup } from '../commands/cleanup.ts'
import { register as registerCode } from '../commands/code.ts'
import { register as registerConfig } from '../commands/config.ts'
import { register as registerContext } from '../commands/context.ts'
import { register as registerDocs } from '../commands/docs.ts'
import { register as registerHealth } from '../commands/health.ts'
import { register as registerInbox } from '../commands/inbox.ts'
import { register as registerJudgment } from '../commands/judgment.ts'
import { register as registerLogic } from '../commands/logic.ts'
import { register as registerRecordAuth } from '../commands/record-auth.ts'
import { register as registerReview } from '../commands/review.ts'
import { register as registerRouting } from '../commands/routing.ts'
import { register as registerRunListing } from '../commands/run-listing.ts'
import { drainStdout, setRawArgv, write } from '../commands/support.ts'
import { register as registerSync } from '../commands/sync.ts'
import { recordSessionSeen } from '../database/db.ts'

export const program = new Command()
  .name('orch')
  .option('--version', 'identify this release or development checkout')
  .enablePositionalOptions()
  .exitOverride()
  .configureOutput({
    writeOut: (value) => write(value),
    writeErr: (value) => process.stderr.write(value),
  })
  .allowUnknownOption(false)
  .allowExcessArguments(false)
  .showSuggestionAfterError()

registerReview(program)
registerCode(program)
registerBranches(program)
registerRecordAuth(program)
registerDocs(program)
registerRunListing(program)
registerHealth(program)
registerInbox(program)
registerCleanup(program)
registerConfig(program)
registerContext(program)
registerJudgment(program)
registerRouting(program)
registerLogic(program)
registerSync(program)

/** Verbs that only read the store must not stamp the session as seen. */
function isReadOnlyInvocation(argv: string[]): boolean {
  if (argv[0] === 'migrate') return true
  if (argv[0] === 'waiting') return true
  if (argv[0] === 'port') return argv[1] === 'import' && argv.includes('--dry-run')
  if (argv[0] === 'canon') return argv[1] === 'audit' && argv.includes('--dry-run')
  if (argv[0] === 'review') return ['coverage-audit', 'yield'].includes(argv[1] ?? '')
  return false
}

/** The exit code for a failure that escaped a command: Commander's own signals map to 0 or 2, everything else is 1. */
function exitCodeFor(error: unknown): number {
  if (!(error instanceof CommanderError)) return 1
  return error.code === 'commander.helpDisplayed' || error.code === 'commander.version' ? 0 : 2
}

/**
 * A reader on a pipe may still be behind when the last write is queued; the
 * process must not end before that write lands, or a large JSON document is
 * cut at the pipe buffer and the caller parses a fragment as the answer.
 */

export async function run(argv: string[]): Promise<number> {
  setRawArgv(argv)
  if (!isReadOnlyInvocation(argv)) recordSessionSeen()
  try {
    await program.parseAsync(['bun', 'orch', ...(argv.length ? argv : ['--help'])])
    await drainStdout()
    return Number(process.exitCode ?? 0)
  } catch (error) {
    const code = exitCodeFor(error)
    if (!(error instanceof CommanderError))
      console.error(error instanceof Error ? error.message : String(error))
    return code
  }
}
