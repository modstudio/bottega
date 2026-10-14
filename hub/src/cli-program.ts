// concern: cli
/** Owns the bought CLI grammar. Must not own application behavior. */
import { Command, CommanderError } from 'commander'
import { installationVersionText } from '../../shared/install-root.ts'
import { registerCoreCommands } from './core-cli.ts'
import { nowIso } from './db.ts'
import { registerNoteCommands } from './note-cli.ts'
import { registerOutboxCommands } from './outbox-cli.ts'
import { registerReportCommands } from './report-cli.ts'
import { registerTaskCommands } from './task-cli.ts'

export const program = new Command()
  .name('hub')
  .description("every project's tasks in flight, what each cost, and scheduled reports")
  .option('--version', 'identify this release or development checkout')
  .option('--verbose', '')
  .exitOverride()
  .allowUnknownOption(false)
  .allowExcessArguments(false)
  .showSuggestionAfterError()
  .addHelpText(
    'after',
    "\nEngaged time is the UNION of every agent's working spans: a session waiting on a\n" +
      'delegated agent is not idle, and two agents running at once did not take twice\n' +
      'as long.\n',
  )
  .action((options: { version?: boolean }) => {
    if (options.version) console.log(installationVersionText(import.meta.dir, process.env))
    else program.help()
  })

registerCoreCommands(program)
registerOutboxCommands(program)
registerTaskCommands(program)
registerNoteCommands(program)
registerReportCommands(program)

function exitCodeFor(error: unknown): number {
  if (!(error instanceof CommanderError)) return 1
  return error.code === 'commander.helpDisplayed' ? 0 : 1
}

export async function run(argv: string[]): Promise<number> {
  try {
    await program.parseAsync(['bun', 'hub', ...(argv.length ? argv : ['--help'])])
    return Number(process.exitCode ?? 0)
  } catch (error) {
    if (!(error instanceof CommanderError))
      console.error(error instanceof Error ? error.message : String(error))
    return exitCodeFor(error)
  } finally {
    if (argv.includes('--verbose')) console.error(`hub ${argv[0]} done at ${nowIso()}`)
  }
}
