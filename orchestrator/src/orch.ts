import { Database } from 'bun:sqlite'
import { COLLECTION_COMMANDS, collect } from './collect.ts'

const argv = process.argv.slice(2)

if (argv[0] === 'init-db') {
  if (argv.length !== 1) {
    console.error('unrecognised argument\nworking form: orch init-db')
    process.exit(1)
  }
  try {
    const { registerStandardHooks } = await import('./store-hooks.ts')
    registerStandardHooks()
    const { initializeDatabase } = await import('./db.ts')
    console.log(`created orchestrator database: ${initializeDatabase()}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  process.exit(0)
}

try {
  const { DB_PATH, missingDatabaseMessage } = await import('./database-location.ts')
  const { existsSync } = await import('node:fs')
  if (!existsSync(DB_PATH)) throw new Error(missingDatabaseMessage())
  const { registerStandardHooks } = await import('./store-hooks.ts')
  registerStandardHooks()
  await import('./cli.ts')
} catch (error) {
  if (!COLLECTION_COMMANDS.has(argv[0] ?? '')) throw error

  const reason = error instanceof Error ? error.message : String(error)
  console.error(`orch: degraded collection mode because the full CLI could not load: ${reason}`)
  try {
    // ORCH_DB is always passed to detached workers. Keep that emergency seam
    // independent of the ordinary resolver so collection still works while a
    // neighbouring source file is temporarily broken during an edit.
    const path = process.env.ORCH_DB ?? (await import('./database-location.ts')).DB_PATH
    const database = new Database(path, { readonly: true })
    // The degraded path is deliberately only collection: output and status,
    // not scoring advice that would require loading the job/router graph.
    await collect(database, argv[0] === 'result' ? [...argv, '--quiet'] : argv)
  } catch (collectionError) {
    console.error(collectionError instanceof Error ? collectionError.message : String(collectionError))
    process.exit(1)
  }
}
