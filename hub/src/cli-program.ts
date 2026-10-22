// concern: cli
/** Owns the bought CLI grammar. Must not own application behavior. */
import { type Command, CommanderError } from 'commander'
import type { OwnerInvocation } from '../../cli/dispatch.ts'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { installationVersionText } from '../../shared/install-root.ts'
import { HubCommand } from './cli-command.ts'
import { registerCoreCommands } from './core-cli.ts'
import { nowIso } from './db.ts'
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
      commandUsage: (command) => {
        const publicPath = publicCommandPaths.get(command)
        if (!publicPath) return defaultCommandUsage(command)
        return `${PLATFORM_SLUG} ${publicPath.join(' ')} ${command.usage()}`
      },
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

const publicCommandPaths = new WeakMap<Command, readonly string[]>()

function defaultCommandUsage(command: Command): string {
  const names: string[] = []
  for (let current: Command | null = command; current; current = current.parent) {
    names.unshift(current.name())
  }
  return `${names.join(' ')} ${command.usage()}`
}

function applyPublicCommandPath(
  root: Command,
  argv: readonly string[],
  invocation?: OwnerInvocation,
): void {
  if (!invocation) return
  let command = root
  let consumed = 0
  while (consumed < argv.length) {
    const child = command.commands.find((candidate) =>
      [candidate.name(), ...candidate.aliases()].includes(argv[consumed]!),
    )
    if (!child) break
    command = child
    consumed += 1
  }
  const suffix = argv.slice(invocation.ownerPath.length, consumed)
  publicCommandPaths.set(command, [...invocation.publicPath, ...suffix])
}

export const program = createHubProgram()

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
  invocation?: OwnerInvocation,
): Promise<number> {
  if (argv.length === 1 && argv[0] === '--version') {
    console.log(installationVersionText(import.meta.dir, process.env))
    return 0
  }
  HubCommand.beginParse()
  applyPublicCommandPath(command, argv, invocation)
  try {
    const input = literalHelp(argv.length ? argv : ['--help'])
    await command.parseAsync(['bun', PLATFORM_SLUG, ...input])
    return Number(process.exitCode ?? 0)
  } catch (error) {
    if (!(error instanceof CommanderError))
      console.error(error instanceof Error ? error.message : String(error))
    return exitCodeFor(error)
  } finally {
    if (argv.includes('--verbose')) console.error(`${PLATFORM_SLUG} ${argv[0]} done at ${nowIso()}`)
  }
}
