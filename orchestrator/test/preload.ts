import { afterAll, beforeEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * One database for the whole suite, chosen by this preload before any test file
 * can import db.ts.
 *
 * db() caches its handle and DB_PATH is read at module load, so a per-test
 * database would need the whole module graph reloaded. Clearing every table
 * between tests is both simpler and closer to how the orchestrator runs.
 */
const dir = mkdtempSync(join(tmpdir(), 'orch-test-'))
const originalPath = process.env.PATH
process.env.ORCH_DB = join(dir, 'test.db')
process.env.ORCH_RUNS = join(dir, 'runs')
mkdirSync(process.env.ORCH_RUNS)

const { bootstrapFixtureStore, db } = await import('../src/db.ts')
bootstrapFixtureStore(process.env.ORCH_DB)

beforeEach(() => {
  // question cascades from run, but the delete order still matters: it is
  // listed first so a future FK-enforcing change cannot make this fail
  // mysteriously halfway through a suite.
  db().exec('DELETE FROM canon_eval; DELETE FROM canon_pack; DELETE FROM monitor_condition; DELETE FROM monitor_invocation; DELETE FROM landing_review_carry; DELETE FROM landing_override; DELETE FROM review_finding; DELETE FROM review_lens; DELETE FROM review; DELETE FROM port_ref_source; DELETE FROM port_ref; DELETE FROM port_skip; DELETE FROM port_baseline; DELETE FROM port_pair; DELETE FROM port_doctrine; DELETE FROM doc_revision; DELETE FROM doc; DELETE FROM run_message; DELETE FROM question; DELETE FROM compared_pair; DELETE FROM duel; DELETE FROM calibration; DELETE FROM score; DELETE FROM run_mutation_audit; DELETE FROM run; DELETE FROM project; DELETE FROM session_seen;')
})

afterAll(() => {
  delete process.env.ORCH_DB
  delete process.env.ORCH_RUNS
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  rmSync(dir, { recursive: true, force: true })
})
