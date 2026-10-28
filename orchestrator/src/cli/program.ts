// concern: cli
/** Owns the bought CLI grammar. Must not own application behavior. */
import { Command, CommanderError } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  applyPublicCommandPath,
  type PublicCommandInvocation,
  publicCommandUsage,
} from '../../../shared/commander-public-path.ts'
import {
  databaseLockHolder,
  formatDatabaseLockRefusal,
  isDatabaseLocked,
} from '../../../shared/database-lock-refusal.ts'
import { processCommandLine } from '../../../shared/process-identity.ts'
import { appendStoreLockRefusal } from '../../../shared/store-lock-refusal-log.ts'
import {
  sampleWalWriteLock,
  type WalWriteLockSampleResult,
} from '../../../shared/store-write-lock.ts'
import { AGENT_COMMAND_VERBS } from '../agent/agent-commands.ts'
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
import { register as registerRunTaskLinking } from '../commands/run-task-linking.ts'
import { register as registerSession } from '../commands/session.ts'
import { register as registerSettings } from '../commands/settings.ts'
import { register as registerSetup } from '../commands/setup.ts'
import { register as registerSpare } from '../commands/spare.ts'
import { register as registerSubjects } from '../commands/subjects.ts'
import { drainStdout, setRawArgv, write } from '../commands/support.ts'
import { register as registerSync } from '../commands/sync.ts'
import { register as registerTestSubstance } from '../commands/test-substance.ts'
import { DB_PATH, withReadOnlyDatabaseAccess } from '../database/db.ts'
import { recordSessionHostPressure } from '../host-pressure/host-pressure-service.ts'
import { classifyRunIdentifier } from '../run/run-identifier.ts'

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
    commandUsage: publicCommandUsage,
  })

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
registerRunTaskLinking(program)
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
registerSpare(program)
registerSync(program)
registerTestSubstance(program)

program.commands
  .find((command) => command.name() === 'agent')!
  .addHelpText('after', `\nValid verbs: ${AGENT_COMMAND_VERBS.join(', ')}`)

export { AGENT_COMMAND_VERBS }

/** Routed internal verbs for public `run show`, `run list`, and `run result`. */
const READ_ONLY_STORE_COMMANDS = ['run', 'runs', 'result', 'gate-facts'] as const

const INVOCATIONS_WITHOUT_SESSION_STAMP = new Set([
  'ask-server',
  'mcp-reader-proxy',
  'migrate',
  'update',
  'gate-facts',
  'ratchet',
  ...READ_ONLY_STORE_COMMANDS,
])

/**
 * Verbs that only read the store must not stamp the session as seen. The ask server is here
 * because its broker declaration must be the process's FIRST store open: a stamp opens the
 * store read-only first, and a handle opened read-only can never be written through afterwards.
 */
export function invocationSkipsSessionStamp(argv: string[]): boolean {
  const readOnlySubcommands: Record<string, readonly string[]> = {
    review: ['coverage-audit', 'scope-proposal', 'yield'],
    pr: ['check'],
    setup: ['facts', 'plan'],
  }
  if (INVOCATIONS_WITHOUT_SESSION_STAMP.has(argv[0]!)) return true
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

export function usesReadOnlyStoreHandle(argv: readonly string[]): boolean {
  const command = argv[0] as (typeof READ_ONLY_STORE_COMMANDS)[number]
  if (!READ_ONLY_STORE_COMMANDS.includes(command)) return false
  if (command === 'gate-facts') return true
  if (command === 'runs') return true
  // Every option these verbs take is a boolean flag, so the first non-flag token is the run id.
  const identifier = argv.slice(1).find((token) => !token.startsWith('-'))
  return classifyRunIdentifier(identifier ?? '') !== null
}

export async function lockedStoreMessage(
  error: unknown,
  inspect: (storePath: string) => Promise<WalWriteLockSampleResult> = sampleWalWriteLock,
  commandOf: (pid: number) => string | null = processCommandLine,
  argv: readonly string[] = [],
): Promise<string> {
  if (!isDatabaseLocked(error)) return error instanceof Error ? error.message : String(error)
  try {
    const sampled = await inspect(DB_PATH)
    const facts = {
      store: DB_PATH,
      holder: databaseLockHolder({
        sampled,
        command:
          sampled.supported && sampled.holderPid !== null ? commandOf(sampled.holderPid) : null,
      }),
    }
    appendStoreLockRefusal(facts, argv)
    return formatDatabaseLockRefusal(facts)
  } catch (inspectionError) {
    const facts = {
      store: DB_PATH,
      holder: databaseLockHolder({ failed: inspectionError }),
    }
    appendStoreLockRefusal(facts, argv)
    return formatDatabaseLockRefusal(facts)
  }
}

/** The exit code for a failure that escaped a command: Commander's own signals map to 0 or 2, everything else is 1. */
export function exitCodeFor(error: unknown): number {
  if (error instanceof CommanderError)
    return error.code === 'commander.helpDisplayed' || error.code === 'commander.version' ? 0 : 2
  const explicit = (error as { exitCode?: unknown } | null)?.exitCode
  if (typeof explicit === 'number' && Number.isInteger(explicit)) return explicit
  return 1
}

/**
 * A reader on a pipe may still be behind when the last write is queued; the
 * process must not end before that write lands, or a large JSON document is
 * cut at the pipe buffer and the caller parses a fragment as the answer.
 */

export function recordInvocationSession(argv: string[]): void {
  if (invocationSkipsSessionStamp(argv)) return
  recordSessionHostPressure()
}

export async function run(argv: string[], invocation?: PublicCommandInvocation): Promise<number> {
  setRawArgv(argv)
  applyPublicCommandPath(program, argv, invocation)
  try {
    const parse = () =>
      program.parseAsync(['bun', PLATFORM_SLUG, ...(argv.length ? argv : ['--help'])])
    await (usesReadOnlyStoreHandle(argv) ? withReadOnlyDatabaseAccess(parse) : parse())
    await drainStdout()
    return Number(process.exitCode ?? 0)
  } catch (error) {
    const code = exitCodeFor(error)
    if (!(error instanceof CommanderError))
      console.error(await lockedStoreMessage(error, undefined, undefined, argv))
    return code
  }
}
