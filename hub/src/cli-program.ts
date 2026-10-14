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

function legacyTaskHelpFailure(argv: string[]): boolean {
  if (argv[0] !== 'task') return false
  let command = program
  let offset = 0
  while (offset < argv.length) {
    const child = command.commands.find(
      (candidate) =>
        candidate.name() === argv[offset] || candidate.aliases().includes(argv[offset]!),
    )
    if (!child) break
    command = child
    offset += 1
  }
  const helpIndex = argv.findIndex(
    (value, index) => index >= offset && (value === '--help' || value === '-h'),
  )
  const required = command.registeredArguments.filter((argument) => argument.required).length
  return helpIndex >= offset && helpIndex - offset < required
}

export async function run(command: Command, argv: string[]): Promise<number> {
  try {
    await command.parseAsync(['bun', 'hub', ...(argv.length ? argv : ['--help'])])
    return Number(process.exitCode ?? 0)
  } catch (error) {
    if (!(error instanceof CommanderError))
      console.error(error instanceof Error ? error.message : String(error))
    const code = exitCodeFor(error)
    return code === 0 && legacyTaskHelpFailure(argv) ? 1 : code
  } finally {
    if (argv.includes('--verbose')) console.error(`hub ${argv[0]} done at ${nowIso()}`)
  }
}
