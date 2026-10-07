import { Database } from 'bun:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { FROZEN_STATE_NAMES } from '../../shared/brand.ts'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from '../../shared/config-directory.ts'
import { createTestHubDatabaseGuard } from '../../shared/test-hub-database.ts'
import { WORKER_ENVIRONMENT_MARKERS } from '../src/caller-classification.ts'

const discoveryEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith('GIT_') &&
      key !== 'ORCH_GUARDED_GIT_COMMON_DIR' &&
      key !== 'ORCH_ALLOWED_GIT_REF',
  ),
)
const commonDir = Bun.spawnSync(['git', 'rev-parse', '--git-common-dir'], {
  cwd: import.meta.dir,
  env: discoveryEnv,
  stdout: 'pipe',
  stderr: 'pipe',
})
if (commonDir.exitCode !== 0) throw new Error(commonDir.stderr.toString())
export const REGISTERED_LIVE_STORE = resolve(
  dirname(resolve(import.meta.dir, commonDir.stdout.toString().trim())),
  'orchestrator',
  FROZEN_STATE_NAMES.orchestratorDatabase,
)

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
export const dir = mkdtempSync(join(tmpdir(), 'orch-test-'))
const originalPath = process.env.PATH
const originalSandbox = process.env.ORCH_SANDBOX
const originalConfigHome = process.env[CONFIG_HOME_ENV]
const originalHarnessEnvFile = process.env[HARNESS_ENV_FILE_ENV]
const originalRecordApiUrl = process.env.ORCH_RECORD_API_URL
const originalRunId = process.env.ORCH_RUN_ID
const originalDepth = process.env.ORCH_DEPTH
const inheritedGitConfig: Record<string, string> = {}
const gitConfigEnvironmentName = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/
const configDir = mkdtempSync(join(tmpdir(), 'orch-test-config-'))
const store = join(dir, 'test.db')
const template = join(dir, 'template.db')
process.env[CONFIG_HOME_ENV] = configDir
process.env[HARNESS_ENV_FILE_ENV] = ''
delete process.env.ORCH_RECORD_API_URL
process.env.ORCH_DB = store
process.env.HUB_DB = join(dir, FROZEN_STATE_NAMES.hubDatabase)
process.env.ORCH_RUNS = join(dir, FROZEN_STATE_NAMES.runsDirectory)
// A fixture landing runs a gate of its own. It must count only fixture gates:
// with the machine's pid directory inherited, a landing spawned inside a gate
// saw the outer gates and held for host capacity until its test expired (four
// landings refused on one lifecycle test on 2026-09-08).
process.env.ORCH_GATE_PIDS = join(dir, 'gates')
// Terminalisation now inventories Docker for every run. Keep the whole suite
// hermetic, including test files that do not import the shared fixture.
export const cleanDockerBin = join(dir, 'clean-docker-bin')
mkdirSync(cleanDockerBin)
writeFileSync(join(cleanDockerBin, 'docker'), '#!/bin/sh\nexit 0\n')
chmodSync(join(cleanDockerBin, 'docker'), 0o755)
// Routing eligibility asks which(agent.bin). The suite decides routes from the
// registry and the evidence, never from which vendor CLIs this host has, so
// every registered binary name resolves to a stand-in that answers a version
// probe and nothing else; no test spawns an agent.
for (const bin of ['codex', 'codex-acp', 'grok', 'agy', 'qwen', 'goose']) {
  writeFileSync(join(cleanDockerBin, bin), '#!/bin/sh\necho "stand-in 999.0.0"\n')
  chmodSync(join(cleanDockerBin, bin), 0o755)
}
process.env.PATH = `${cleanDockerBin}:${originalPath ?? ''}`
process.env.ORCH_SANDBOX = 'host'
export const PRELOAD_STORE = process.env.ORCH_DB
export const PRELOAD_RUNS = process.env.ORCH_RUNS
mkdirSync(process.env.ORCH_RUNS)

const assertTestHubDatabase = createTestHubDatabaseGuard()
assertTestHubDatabase()

const { registerStandardRuntime } = await import('../src/runtime/runtime-registration.ts')
registerStandardRuntime()
const { DB_PATH, closeDatabaseForFixture } = await import('../src/database/db.ts')
const { applyMigrations } = await import('../src/database/migrations.ts')
const { excludeSharedOutputRuns } = await import('../src/evidence/evidence-query.ts')
const { seedWorkflows } = await import('../src/workflow/workflow-seeds.ts')
const { registerStandardTransports } = await import('../src/runtime/standard-transports.ts')

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
  if (
    real(DB_PATH) !== real(store) ||
    !real(DB_PATH).startsWith(`${ownedDir}/`) ||
    !ownedDir.startsWith(realpathSync(tmpdir()))
  ) {
    throw new Error(
      `test preload refuses to run: db.ts resolved ${DB_PATH}, not the fixture store ${store} under ${tmpdir()}\n` +
        'invariant: A test suite only ever writes a store its own preload created.\n' +
        'cleared by: bun test from orchestrator/ with ORCH_DB unset',
    )
  }
}

assertOwnedStore()
mkdirSync(dirname(template), { recursive: true })
{
  const fixture = new Database(template, { create: true })
  try {
    fixture.exec('PRAGMA foreign_keys = ON;')
    applyMigrations(fixture)
    excludeSharedOutputRuns(fixture)
    seedWorkflows(fixture)
  } finally {
    fixture.close()
  }
}
copyFileSync(template, store)
{
  const { recordAgentProbe } = await import('../src/agent/agent-probe.ts')
  const { refreshAgents } = await import('../src/agent/agent-registry.ts')
  const fileProbe = (harness: string) => ({
    harness,
    ok: true,
    reply: { ok: true, output: 'ok' },
    tool: {
      ok: true,
      output: 'REGISTRATION_PROBE_FILE_OK',
      toolEvents: 1,
      statuses: ['completed'],
    },
    schema: { ok: true, output: '{"status":"ok"}' },
    file: { ok: true, output: '{"status":"ok"}' },
    contextTokens: null as number | null,
    contextSource: 'declared' as const,
  })
  recordAgentProbe('codex', fileProbe('codex'))
  recordAgentProbe('grok', fileProbe('grok'))
  closeDatabaseForFixture()
  copyFileSync(store, template)
  refreshAgents()
}

const { createMemoryRecordApiClient, installRecordApiClient } = await import(
  './fixtures/record-api.ts'
)
installRecordApiClient(createMemoryRecordApiClient())

const { db } = await import('../src/database/db.ts')

/**
 * Run ids keep climbing across tests, as they did when tables were cleared
 * (DELETE never reset sqlite_sequence). A fresh file would restart them at 1,
 * and a test's scratch worktree named after run 1 would then collide with the
 * previous test's. The sequence is the one thing carried from store to store.
 */
let sequence: { name: string; seq: number }[] = []
let childrenBeforeTest = new Set<string>()
let callerEnvironmentBeforeTest: Record<string, string | undefined> = {}
const callerEnvironmentKey = (key: string) =>
  WORKER_ENVIRONMENT_MARKERS.includes(key as (typeof WORKER_ENVIRONMENT_MARKERS)[number]) ||
  /(?:SESSION_ID|THREAD_ID)$/.test(key)

beforeAll(() => {
  for (const key of Object.keys(process.env)) {
    if (callerEnvironmentKey(key)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (!gitConfigEnvironmentName.test(key) || value === undefined) continue
    inheritedGitConfig[key] = value
    delete process.env[key]
  }
})

beforeEach(() => {
  callerEnvironmentBeforeTest = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => callerEnvironmentKey(key)),
  )
  installRecordApiClient(createMemoryRecordApiClient())
  registerStandardTransports()
  assertTestHubDatabase()
  if (process.env.ORCH_DB && resolve(process.env.ORCH_DB) === REGISTERED_LIVE_STORE) {
    throw new Error(`test process refuses registered live store: ${REGISTERED_LIVE_STORE}`)
  }
  assertOwnedStore()
  try {
    sequence = db().query('SELECT name, seq FROM sqlite_sequence').all() as {
      name: string
      seq: number
    }[]
  } catch {
    /* an unopenable store carries nothing forward */
  }
  closeDatabaseForFixture()
  for (const sidecar of ['', '-wal', '-shm', '-journal'])
    rmSync(`${store}${sidecar}`, { force: true })
  copyFileSync(template, store)
  if (sequence.length > 0) {
    const fresh = db()
    // sqlite_sequence carries no unique constraint, so an upsert is refused.
    for (const { name, seq } of sequence) {
      const bumped = fresh.query('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(seq, name)
      if (bumped.changes === 0)
        fresh.query('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(name, seq)
    }
  }
  childrenBeforeTest = new Set(readdirSync(dir))
})

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (callerEnvironmentKey(key)) delete process.env[key]
  }
  Object.assign(process.env, callerEnvironmentBeforeTest)
})

/**
 * The preload provisions the suite root, so it owns the root's teardown: what a
 * test left is measured first (a warning here, a failure on CI, so the fixture
 * that should have released it is named), then released so nothing accumulates
 * across the file.
 */
afterEach(() => {
  const residue = readdirSync(dir).filter(
    (name) => !childrenBeforeTest.has(name) && !name.startsWith('git-template-'),
  )
  if (residue.length === 0) return
  const message = residue
    .map((name) => `test ${Bun.main} left fixture residue: ${join(dir, name)}`)
    .join('\n')
  for (const name of residue) rmSync(join(dir, name), { recursive: true, force: true })
  if (process.env.CI) throw new Error(message)
  console.warn(message)
})

afterAll(() => {
  closeDatabaseForFixture()
  delete process.env.ORCH_DB
  delete process.env.HUB_DB
  delete process.env.ORCH_RUNS
  delete process.env.ORCH_GATE_PIDS
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  if (originalSandbox === undefined) delete process.env.ORCH_SANDBOX
  else process.env.ORCH_SANDBOX = originalSandbox
  if (originalConfigHome === undefined) delete process.env[CONFIG_HOME_ENV]
  else process.env[CONFIG_HOME_ENV] = originalConfigHome
  if (originalHarnessEnvFile === undefined) delete process.env[HARNESS_ENV_FILE_ENV]
  else process.env[HARNESS_ENV_FILE_ENV] = originalHarnessEnvFile
  if (originalRecordApiUrl === undefined) delete process.env.ORCH_RECORD_API_URL
  else process.env.ORCH_RECORD_API_URL = originalRecordApiUrl
  if (originalRunId === undefined) delete process.env.ORCH_RUN_ID
  else process.env.ORCH_RUN_ID = originalRunId
  if (originalDepth === undefined) delete process.env.ORCH_DEPTH
  else process.env.ORCH_DEPTH = originalDepth
  for (const key of Object.keys(process.env)) {
    if (gitConfigEnvironmentName.test(key)) delete process.env[key]
  }
  Object.assign(process.env, inheritedGitConfig)
  rmSync(configDir, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})
