import { Database } from 'bun:sqlite'
import { installationVersionText } from '../../../shared/install-root.ts'
import { COLLECTION_COMMANDS, collect } from '../collect/collect.ts'

function versionCommand(): number {
  try {
    console.log(installationVersionText(import.meta.dir, process.env))
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

async function initDatabaseCommand(argv: string[]): Promise<number> {
  if (argv.length !== 1) {
    console.error('unrecognized argument\nworking form: orch init-db')
    return 1
  }
  try {
    const { registerStandardRuntime } = await import('../runtime/runtime-registration.ts')
    registerStandardRuntime()
    const { initializeDatabase } = await import('../database/db.ts')
    console.log(initializeDatabase())
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

async function fullCli(argv: string[], storeFree: boolean): Promise<number> {
  const { registerStandardRuntime } = await import('../runtime/runtime-registration.ts')
  registerStandardRuntime()
  if (!storeFree && argv[0] !== 'migrate') {
    const { ensureDatabase } = await import('../database/db.ts')
    ensureDatabase()
  }
  const { recordInvocationSession, run } = await import('./program.ts')
  if (!storeFree) recordInvocationSession(argv)
  return run(argv)
}

/** The one outer-boundary decision that keeps informational invocations store-free. */
export function isHelpShapedInvocation(argv: string[]): boolean {
  return (
    argv.length === 0 ||
    argv[0] === 'help' ||
    argv.includes('--help') ||
    argv.includes('-h') ||
    argv.includes('--version')
  )
}

/** Informational commands that neither need nor stamp the orchestrator store. */
export function isStoreFreeInvocation(argv: string[]): boolean {
  return (
    isHelpShapedInvocation(argv) ||
    (argv[0] === 'setup' && argv[1] === 'facts') ||
    (argv[0] === 'test-substance' && argv[1] === 'judge') ||
    (argv[0] === 'release' && argv[1] === 'check')
  )
}

async function degradedCollection(argv: string[], error: unknown): Promise<number> {
  const reason = error instanceof Error ? error.message : String(error)
  console.error(`orch: degraded collection mode because the full CLI could not load: ${reason}`)
  try {
    // ORCH_DB is always passed to detached workers. Keep that emergency seam
    // independent of the ordinary resolver so collection still works while a
    // neighboring source file is temporarily broken during an edit.
    const path = process.env.ORCH_DB || (await import('../database/database-location.ts')).DB_PATH
    const database = new Database(path, { readonly: true })
    // The degraded path is deliberately only collection: output and status,
    // not scoring advice that would require loading the job/router graph.
    await collect(database, argv[0] === 'result' ? [...argv, '--quiet'] : argv)
    return 0
  } catch (collectionError) {
    console.error(
      collectionError instanceof Error ? collectionError.message : String(collectionError),
    )
    return 1
  }
}

export async function main(argv: string[]): Promise<number> {
  const storeFree = isStoreFreeInvocation(argv)
  if (argv.length === 1 && argv[0] === '--version') return versionCommand()
  if (argv[0] === 'init-db' && !storeFree) return initDatabaseCommand(argv)
  try {
    return await fullCli(argv, storeFree)
  } catch (error) {
    if (argv[0] === 'ask-server') {
      const { writeAskServerFailure } = await import('../ask/ask-failure.ts')
      writeAskServerFailure(error)
    }
    if (!COLLECTION_COMMANDS.has(argv[0] ?? '')) throw error
    return degradedCollection(argv, error)
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
