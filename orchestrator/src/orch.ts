import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { COLLECTION_COMMANDS, collect } from './collect.ts'

const argv = process.argv.slice(2)

try {
  await import('./cli.ts')
} catch (error) {
  if (!COLLECTION_COMMANDS.has(argv[0] ?? '')) throw error

  const reason = error instanceof Error ? error.message : String(error)
  console.error(`orch: degraded collection mode because the full CLI could not load: ${reason}`)
  try {
    const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
    const database = new Database(process.env.ORCH_DB ?? join(root, 'orch.db'), { readonly: true })
    // The degraded path is deliberately only collection: output and status,
    // not scoring advice that would require loading the job/router graph.
    await collect(database, argv[0] === 'result' ? [...argv, '--quiet'] : argv)
  } catch (collectionError) {
    console.error(collectionError instanceof Error ? collectionError.message : String(collectionError))
    process.exit(1)
  }
}
