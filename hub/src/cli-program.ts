// concern: cli
/** Owns the bought CLI grammar. Must not own application behavior. */
import { type Command, CommanderError } from 'commander'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  applyPublicCommandPath,
  type PublicCommandInvocation,
  publicCommandUsage,
} from '../../shared/commander-public-path.ts'
import { formatDatabaseLockRefusal, isDatabaseLocked } from '../../shared/database-lock-refusal.ts'
import { installationVersionText } from '../../shared/install-root.ts'
import { HubCommand } from './cli-command.ts'
import { registerCoreCommands } from './core-cli.ts'
import { DB_PATH, hubDatabaseLockHolder, nowIso, withReadOnlyDatabaseAccess } from './db.ts'
import { registerNoteCommands } from './note-cli.ts'
import { registerOutboxCommands } from './outbox-cli.ts'
import { registerReportCommands } from './report-cli.ts'
import { registerTaskCommands } from './task-cli.ts'

export function createHubProgram(): HubCommand {
  const command = new HubCommand()
    .name(PLATFORM_SLUG)
    .description("every project's tasks in flight, what each cost, and scheduled reports")
    .option('--verbose', '')
    .exitOverride()
    .allowUnknownOption(false)
    .allowExcessArguments(false)
    .showSuggestionAfterError()
    .configureHelp({
      commandUsage: publicCommandUsage,
    })
    .addHelpText(
      'after',
      "\nEngaged time is the UNION of every agent's working spans: a session waiting on a\n" +
        'delegated agent is not idle, and two agents running at once did not take twice\n' +
        'as long.\n',
    )
    .action((_options, actionCommand) => actionCommand.help())
  registerCoreCommands(command)
  registerOutboxCommands(command)
  registerTaskCommands(command)
  registerNoteCommands(command)
  registerReportCommands(command)
  return command
}

export const program = createHubProgram()

const READ_ONLY_STORE_COMMANDS = ['list', 'show'] as const

/** Store queries whose result does not refresh an external tracker. */
export function usesReadOnlyStoreHandle(argv: readonly string[]): boolean {
  if (argv[0] !== 'task') return false
  if (!READ_ONLY_STORE_COMMANDS.includes(argv[1] as (typeof READ_ONLY_STORE_COMMANDS)[number]))
    return false
  return argv[1] !== 'show' || !argv.includes('--fresh')
}

function exitCodeFor(error: unknown): number {
  if (!(error instanceof CommanderError)) return 1
  return error.code === 'commander.helpDisplayed' ? 0 : 1
}

function literalHelp(argv: string[]): string[] {
  if (argv[0] === 'help') return ['--help']
  if (argv[1] === 'help') return [argv[0]!, '--help']
  if (argv[0] === 'task' && ['doc', 'document'].includes(argv[1] ?? '') && argv[2] === 'help')
    return [argv[0], argv[1]!, '--help']
  return argv
}

export async function run(
  command: Command,
  argv: string[],
  invocation?: PublicCommandInvocation,
): Promise<number> {
  if (argv.length === 1 && argv[0] === '--version') {
    console.log(installationVersionText(import.meta.dir, process.env))
    return 0
  }
  HubCommand.beginParse()
  applyPublicCommandPath(command, argv, invocation)
  try {
    const input = literalHelp(argv.length ? argv : ['--help'])
    const parse = () => command.parseAsync(['bun', PLATFORM_SLUG, ...input])
    await (usesReadOnlyStoreHandle(argv) ? withReadOnlyDatabaseAccess(parse) : parse())
    return Number(process.exitCode ?? 0)
  } catch (error) {
    if (!(error instanceof CommanderError))
      console.error(
        isDatabaseLocked(error)
          ? formatDatabaseLockRefusal({
              store: DB_PATH,
              holder: await hubDatabaseLockHolder(),
            })
          : error instanceof Error
            ? error.message
            : String(error),
      )
    return exitCodeFor(error)
  } finally {
    if (argv.includes('--verbose')) console.error(`${PLATFORM_SLUG} ${argv[0]} done at ${nowIso()}`)
  }
}
