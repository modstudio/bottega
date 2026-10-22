// concern: cli
/** Owns the bought CLI grammar. Must not own application behavior. */
import { Command, CommanderError } from 'commander'
import type { OwnerInvocation } from '../../../cli/dispatch.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { registerBoardCommands } from '../board/board-commands.ts'
import { register as registerBranches } from '../commands/branches.ts'
import { register as registerCleanup } from '../commands/cleanup.ts'
import { register as registerCode } from '../commands/code.ts'
import { register as registerConfig } from '../commands/config.ts'
import { register as registerContext } from '../commands/context.ts'
import { register as registerDocs } from '../commands/docs.ts'
import { register as registerHealth } from '../commands/health.ts'
import { register as registerHubImport } from '../commands/hub-import.ts'
import { register as registerInbox } from '../commands/inbox.ts'
import { register as registerJudgment } from '../commands/judgment.ts'
import { register as registerLogic } from '../commands/logic.ts'
import { register as registerPullRequest } from '../commands/pull-request.ts'
import { register as registerRatchet } from '../commands/ratchet.ts'
import { register as registerRecordAuth } from '../commands/record-auth.ts'
import { register as registerReference } from '../commands/reference.ts'
import { register as registerRelease } from '../commands/release.ts'
import { register as registerReview } from '../commands/review.ts'
import { register as registerRouting } from '../commands/routing.ts'
import { register as registerRulings } from '../commands/rulings.ts'
import { register as registerRunListing } from '../commands/run-listing.ts'
import { register as registerSession } from '../commands/session.ts'
import { register as registerSettings } from '../commands/settings.ts'
import { register as registerSetup } from '../commands/setup.ts'
import { register as registerSubjects } from '../commands/subjects.ts'
import { drainStdout, setRawArgv, write } from '../commands/support.ts'
import { register as registerSync } from '../commands/sync.ts'
import { register as registerTestSubstance } from '../commands/test-substance.ts'
import { recordSessionSeen } from '../database/db.ts'

export const program = new Command()
  .name(PLATFORM_SLUG)
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
  .configureHelp({
    commandUsage: (command) => {
      const publicPath = publicCommandPaths.get(command)
      if (!publicPath) return defaultCommandUsage(command)
      return `${PLATFORM_SLUG} ${publicPath.join(' ')} ${command.usage()}`
    },
  })

const publicCommandPaths = new WeakMap<Command, readonly string[]>()

function defaultCommandUsage(command: Command): string {
  const names: string[] = []
  for (let current: Command | null = command; current; current = current.parent) {
    names.unshift(current.name())
  }
  return `${names.join(' ')} ${command.usage()}`
}

function applyPublicCommandPath(argv: readonly string[], invocation?: OwnerInvocation): void {
  if (!invocation) return
  let command = program
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

registerReview(program)
registerPullRequest(program)
registerCode(program)
registerBranches(program)
registerBoardCommands(program)
registerRecordAuth(program)
registerRelease(program)
registerRatchet(program)
registerReference(program)
registerDocs(program)
registerSubjects(program)
registerRunListing(program)
registerHealth(program)
registerHubImport(program)
registerInbox(program)
registerCleanup(program)
registerConfig(program)
registerContext(program)
registerJudgment(program)
registerRouting(program)
registerRulings(program)
registerLogic(program)
registerSettings(program)
registerSession(program)
registerSetup(program)
registerSync(program)
registerTestSubstance(program)

const READ_ONLY_COMMANDS = new Set(['mcp-reader-proxy', 'migrate', 'ratchet'])

/** Verbs that only read the store must not stamp the session as seen. */
function isReadOnlyInvocation(argv: string[]): boolean {
  const readOnlySubcommands: Record<string, readonly string[]> = {
    review: ['coverage-audit', 'yield'],
    pr: ['check'],
    setup: ['facts', 'plan'],
  }
  if (READ_ONLY_COMMANDS.has(argv[0]!)) return true
  // Monitor owns its writable open so it can diagnose that open when the store is locked.
  // The lock-holder-only path never opens SQLite writable at all.
  if (argv[0] === 'monitor') return true
  if (argv[0] === 'waiting') return true
  if (argv[0] === 'port') return argv[1] === 'import' && argv.includes('--dry-run')
  if (argv[0] === 'canon') return argv[1] === 'audit' && argv.includes('--dry-run')
  if (readOnlySubcommands[argv[0]!]?.includes(argv[1] ?? '')) return true
  if (argv[0] === 'settings') {
    if (argv[1] === 'render' && argv.includes('--check')) return true
    if (argv[1] === 'import' && argv.includes('--dry-run')) return true
  }
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

export function recordInvocationSession(argv: string[]): void {
  if (!isReadOnlyInvocation(argv)) recordSessionSeen()
}

export async function run(argv: string[], invocation?: OwnerInvocation): Promise<number> {
  setRawArgv(argv)
  applyPublicCommandPath(argv, invocation)
  try {
    await program.parseAsync(['bun', PLATFORM_SLUG, ...(argv.length ? argv : ['--help'])])
    await drainStdout()
    return Number(process.exitCode ?? 0)
  } catch (error) {
    const code = exitCodeFor(error)
    if (!(error instanceof CommanderError))
      console.error(error instanceof Error ? error.message : String(error))
    return code
  }
}
