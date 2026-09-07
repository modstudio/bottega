import { afterAll, beforeEach } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/**
 * A fresh store for every test, minted by this preload before any test file can
 * import db.ts.
 *
 * The preload used to clear every table between tests with DELETE statements.
 * On 2026-09-07 those statements ran against the live orchestrator database:
 * the dispatcher exports ORCH_DB to every worker, and a worker's test leg from
 * a linked worktree emptied 27 tables. A fixture that CREATES cannot be aimed at
 * the wrong target; a fixture that CLEARS can, and had been, so there is no
 * clearing statement left here to aim. db() caches one process-wide handle and
 * DB_PATH is read at module load, so the handle is released and the file
 * replaced from a template rather than the module graph reloaded.
 */
const dir = mkdtempSync(join(tmpdir(), 'orch-test-'))
const originalPath = process.env.PATH
const store = join(dir, 'test.db')
const template = join(dir, 'template.db')
process.env.ORCH_DB = store
process.env.ORCH_RUNS = join(dir, 'runs')
mkdirSync(process.env.ORCH_RUNS)

const { DB_PATH, bootstrapFixtureStore, closeDatabaseForFixture } = await import('../src/db.ts')

/**
 * The store db.ts resolved must be the one minted above, inside a directory
 * this preload created under the temporary directory. Anything else means an
 * import ran ahead of the environment or ORCH_DB was replaced, and the suite
 * would be about to run against a store it does not own. Refuse before a single
 * test writes.
 */
function assertOwnedStore(): void {
  // The file may not exist yet, so the directory is what gets resolved.
  const real = (path: string) => join(realpathSync(dirname(path)), basename(path))
  const ownedDir = realpathSync(dir)
  if (real(DB_PATH) !== real(store) || !real(DB_PATH).startsWith(`${ownedDir}/`) || !ownedDir.startsWith(realpathSync(tmpdir()))) {
    throw new Error(
      `test preload refuses to run: db.ts resolved ${DB_PATH}, not the fixture store ${store} under ${tmpdir()}\n` +
      'invariant: A test suite only ever writes a store its own preload created.\n' +
      'cleared by: bun test from orchestrator/ with ORCH_DB unset',
    )
  }
}

assertOwnedStore()
bootstrapFixtureStore(template)

const { db } = await import('../src/db.ts')

/**
 * Run ids keep climbing across tests, as they did when tables were cleared
 * (DELETE never reset sqlite_sequence). A fresh file would restart them at 1,
 * and a test's scratch worktree named after run 1 would then collide with the
 * previous test's. The sequence is the one thing carried from store to store.
 */
let sequence: { name: string; seq: number }[] = []

beforeEach(() => {
  assertOwnedStore()
  try {
    sequence = db().query('SELECT name, seq FROM sqlite_sequence').all() as { name: string; seq: number }[]
  } catch { /* an unopenable store carries nothing forward */ }
  closeDatabaseForFixture()
  for (const sidecar of ['', '-wal', '-shm', '-journal']) rmSync(`${store}${sidecar}`, { force: true })
  copyFileSync(template, store)
  if (sequence.length === 0) return
  const fresh = db()
  // sqlite_sequence carries no unique constraint, so an upsert is refused.
  for (const { name, seq } of sequence) {
    const bumped = fresh.query('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(seq, name)
    if (bumped.changes === 0) fresh.query('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(name, seq)
  }
})

afterAll(() => {
  closeDatabaseForFixture()
  delete process.env.ORCH_DB
  delete process.env.ORCH_RUNS
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  rmSync(dir, { recursive: true, force: true })
})
