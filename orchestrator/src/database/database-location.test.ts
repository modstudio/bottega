import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FROZEN_STATE_NAMES, PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { LEGACY_ORCHESTRATOR_DATABASE } from '../../../shared/state-directory.ts'
import {
  decideOrchestratorDatabasePath,
  existingDatabaseMigrationRefusal,
  implicitDatabaseCreationRefusal,
  legacyDatabaseRefusal,
  linkedWorktreeDatabaseInitializationMessage,
  missingDatabaseMessage,
  missingWorkingDirectoryFallback,
  unauthorizedDatabaseInitializationMessage,
  workerStoreMigrationRefusal,
} from './database-location.ts'

test('default open refuses legacy-only state and accepts the current filename', () => {
  const root = join(tmpdir(), `legacy-store-refusal-${randomUUID()}`)
  const directory = join(root, 'orchestrator')
  mkdirSync(directory, { recursive: true })
  const current = join(directory, FROZEN_STATE_NAMES.orchestratorDatabase)
  const legacy = join(directory, LEGACY_ORCHESTRATOR_DATABASE)
  const resolution = {
    path: current,
    method: 'state-root' as const,
    tried: [current],
    registeredPath: null,
    repositoryRoot: '/checkout',
    initializable: true,
    linkedWorktreeBinary: false,
    mainStorePath: current,
  }
  try {
    writeFileSync(legacy, 'legacy')
    expect(legacyDatabaseRefusal(resolution, { BOTTEGA_STATE_HOME: root })).toContain(
      'machine setup apply',
    )
    rmSync(legacy)
    writeFileSync(current, 'current')
    expect(legacyDatabaseRefusal(resolution, { BOTTEGA_STATE_HOME: root })).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('default open refuses a lone legacy rollback journal', () => {
  const root = join(tmpdir(), `legacy-journal-refusal-${randomUUID()}`)
  const directory = join(root, 'orchestrator')
  mkdirSync(directory, { recursive: true })
  const current = join(directory, FROZEN_STATE_NAMES.orchestratorDatabase)
  const legacy = join(directory, LEGACY_ORCHESTRATOR_DATABASE)
  const resolution = {
    path: current,
    method: 'state-root' as const,
    tried: [current],
    registeredPath: null,
    repositoryRoot: '/checkout',
    initializable: true,
    linkedWorktreeBinary: false,
    mainStorePath: current,
  }
  try {
    writeFileSync(`${legacy}-journal`, 'journal')
    expect(legacyDatabaseRefusal(resolution, { BOTTEGA_STATE_HOME: root })).toContain(
      `${legacy}-journal`,
    )
    const { BOTTEGA_ORCHESTRATOR_DB: _ignored, ...env } = process.env
    const result = Bun.spawnSync(
      [
        process.execPath,
        '--no-env-file',
        '-e',
        `import { ensureDatabase } from ${JSON.stringify(join(import.meta.dir, 'db.ts'))}; try { ensureDatabase(); process.exit(2) } catch (error) { console.error(error instanceof Error ? error.message : String(error)) }`,
      ],
      {
        env: { ...env, BOTTEGA_STATE_HOME: root, NODE_ENV: 'production' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toContain(`${legacy}-journal`)
    expect(existsSync(current)).toBeFalse()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('default open directs an interrupted move back to setup apply', () => {
  const root = join(tmpdir(), `interrupted-store-refusal-${randomUUID()}`)
  const directory = join(root, 'orchestrator')
  mkdirSync(directory, { recursive: true })
  const current = join(directory, FROZEN_STATE_NAMES.orchestratorDatabase)
  const legacy = join(directory, LEGACY_ORCHESTRATOR_DATABASE)
  const resolution = {
    path: current,
    method: 'state-root' as const,
    tried: [current],
    registeredPath: null,
    repositoryRoot: '/checkout',
    initializable: true,
    linkedWorktreeBinary: false,
    mainStorePath: current,
  }
  try {
    writeFileSync(current, 'store')
    writeFileSync(`${legacy}-wal`, 'wal')
    const refusal = legacyDatabaseRefusal(resolution, { BOTTEGA_STATE_HOME: root })
    expect(refusal).toContain('machine setup apply completes the interrupted move')
    expect(refusal).not.toContain('remove the other')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('database entry points refuse legacy-only state before opening the destination', () => {
  const root = join(tmpdir(), `legacy-store-entry-${randomUUID()}`)
  const directory = join(root, 'orchestrator')
  mkdirSync(directory, { recursive: true })
  const legacy = join(directory, LEGACY_ORCHESTRATOR_DATABASE)
  const current = join(directory, FROZEN_STATE_NAMES.orchestratorDatabase)
  writeFileSync(legacy, 'legacy')
  const { BOTTEGA_ORCHESTRATOR_DB: _ignored, ...env } = process.env
  try {
    for (const subject of ['ensureDatabase', 'openReadOnlyDatabase']) {
      const result = Bun.spawnSync(
        [
          process.execPath,
          '--no-env-file',
          '-e',
          `import { ${subject} } from ${JSON.stringify(join(import.meta.dir, 'db.ts'))}; try { ${subject}(); process.exit(2) } catch (error) { console.error(error instanceof Error ? error.message : String(error)) }`,
        ],
        {
          env: { ...env, BOTTEGA_STATE_HOME: root, NODE_ENV: 'production' },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      expect(result.exitCode).toBe(0)
      expect(result.stderr.toString()).toContain('machine setup apply')
      expect(existsSync(current)).toBeFalse()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const livePath = '/nonexistent-live-orchestrator-store/orchestrator.db'
const tempPath = '/nonexistent-temp-orchestrator-store/orchestrator.db'

describe('missing working directory fallback', () => {
  const facts = {
    mainCheckout: '/projects/main',
    binaryRepositoryRoot: '/install',
    binaryRoot: '/install/orchestrator',
  }

  test('a removed working directory continues in the main checkout', () => {
    const removed = Object.assign(new Error('ENOENT: process.cwd failed'), { code: 'ENOENT' })
    expect(missingWorkingDirectoryFallback(removed, facts)).toBe('/projects/main')
    expect(missingWorkingDirectoryFallback(removed, { ...facts, mainCheckout: undefined })).toBe(
      '/install',
    )
  })

  test('any other working directory failure is rethrown', () => {
    const denied = Object.assign(new Error('EACCES: process.cwd failed'), { code: 'EACCES' })
    expect(() => missingWorkingDirectoryFallback(denied, facts)).toThrow('EACCES')
  })
})

describe('orchestrator database path decision', () => {
  test('test process + non-BOTTEGA_ORCHESTRATOR_DB method: refuses the live fallback', () => {
    expect(() => decideOrchestratorDatabasePath(true, 'state-root', livePath)).toThrow(
      `test process refuses orchestrator database: BOTTEGA_ORCHESTRATOR_DB resolved <unset>; live store is ${livePath}\n` +
        'invariant: A test suite never falls back to the live orchestrator database.\n' +
        'cleared by: set BOTTEGA_ORCHESTRATOR_DB to a scratch store before importing orchestrator/src/database/db.ts',
    )
  })

  test("test process + 'BOTTEGA_ORCHESTRATOR_DB' method: returns the path", () => {
    expect(decideOrchestratorDatabasePath(true, 'BOTTEGA_ORCHESTRATOR_DB', tempPath)).toBe(tempPath)
  })

  test('non-test + fallback method: returns the path', () => {
    expect(decideOrchestratorDatabasePath(false, 'state-root', livePath)).toBe(livePath)
  })
})

test('the unauthorized default-store refusal names the condition and remedy', () => {
  expect(unauthorizedDatabaseInitializationMessage('/state/orchestrator.db')).toBe(
    `refusing to initialize the default store: cannot establish an authorized ${PLATFORM_NAME} installation: /state/orchestrator.db\n` +
      'invariant: A default store is initialized only by a checkout or an installed distribution.\n' +
      `cleared by: run the command from the main checkout or reinstall ${PLATFORM_NAME}`,
  )
})

test('the absent explicit-store refusal names the condition and explicit remedy', () => {
  expect(missingDatabaseMessage('/scratch/missing.db')).toBe(
    'orchestrator database does not exist: /scratch/missing.db\n' +
      'invariant: An absent BOTTEGA_ORCHESTRATOR_DB path is a mistake, not a request to create a store.\n' +
      'cleared by: unset BOTTEGA_ORCHESTRATOR_DB to use the installation store, or name an existing database',
  )
})

test('implicit creation uses the existing installation authority decision', () => {
  const authorized = {
    path: '/state/orchestrator.db',
    method: 'state-root' as const,
    tried: ['/state/orchestrator.db'],
    registeredPath: null,
    repositoryRoot: '/checkout',
    initializable: true,
    linkedWorktreeBinary: false,
    mainStorePath: '/state/orchestrator.db',
  }
  expect(implicitDatabaseCreationRefusal(authorized)).toBeNull()
  expect(
    implicitDatabaseCreationRefusal(
      { ...authorized, linkedWorktreeBinary: true },
      '/installation/state/orchestrator.db',
    ),
  ).toBe(linkedWorktreeDatabaseInitializationMessage())
  expect(implicitDatabaseCreationRefusal({ ...authorized, initializable: false })).toBe(
    unauthorizedDatabaseInitializationMessage('/state/orchestrator.db'),
  )
  expect(
    implicitDatabaseCreationRefusal({ ...authorized, method: 'BOTTEGA_ORCHESTRATOR_DB' }),
  ).toBe(missingDatabaseMessage('/state/orchestrator.db'))
})

test('migrating an existing store retains the linked-worktree refusal', () => {
  const existing = {
    path: '/state/orchestrator.db',
    method: 'state-root' as const,
    tried: ['/state/orchestrator.db'],
    registeredPath: null,
    repositoryRoot: '/checkout',
    initializable: true,
    linkedWorktreeBinary: true,
    mainStorePath: '/state/orchestrator.db',
  }

  expect(existingDatabaseMigrationRefusal(existing)).toBe(
    linkedWorktreeDatabaseInitializationMessage(),
  )
  expect(existingDatabaseMigrationRefusal({ ...existing, linkedWorktreeBinary: false })).toBeNull()
})

test('a worker caller may not migrate the shared store, the ask server included', () => {
  const shared = {
    path: '/state/orchestrator.db',
    method: 'state-root' as const,
    tried: ['/state/orchestrator.db'],
    registeredPath: null,
    repositoryRoot: '/checkout',
    initializable: true,
    linkedWorktreeBinary: false,
    mainStorePath: '/state/orchestrator.db',
  }

  // The migration decision takes no broker-channel fact, so the ask server's worker environment is refused here too.
  expect(existingDatabaseMigrationRefusal(shared, true)).toBe(
    workerStoreMigrationRefusal(shared.path),
  )
  expect(implicitDatabaseCreationRefusal(shared, shared.path, true)).toBe(
    workerStoreMigrationRefusal(shared.path),
  )
  expect(workerStoreMigrationRefusal(shared.path)).toBe(
    `refusing to migrate the orchestrator store from a worker: ${shared.path}\n` +
      'invariant: A worker never changes the store it reads, because a schema change under a live process breaks every run in flight.\n' +
      `cleared by: the operator runs ${PLATFORM_SLUG} machine update from the main checkout`,
  )
})

test('a worker caller may still create and migrate the isolated store its test leg mints under temporary state', () => {
  const path = join(tmpdir(), `orch-worker-scratch-${randomUUID()}`, 'orchestrator.db')
  const scratch = {
    path,
    method: 'state-root' as const,
    tried: [path],
    registeredPath: null,
    repositoryRoot: '/checkout',
    initializable: true,
    linkedWorktreeBinary: false,
    mainStorePath: path,
  }

  expect(existingDatabaseMigrationRefusal(scratch, true)).toBeNull()
  expect(implicitDatabaseCreationRefusal(scratch, path, true)).toBeNull()
})

test('a linked-worktree binary may create and migrate a temporary store', () => {
  const path = join(tmpdir(), `orch-linked-scratch-${randomUUID()}`, 'orchestrator.db')
  const scratch = {
    path,
    method: 'state-root' as const,
    tried: [path],
    registeredPath: null,
    repositoryRoot: '/checkout',
    initializable: false,
    linkedWorktreeBinary: true,
    mainStorePath: path,
  }

  expect(implicitDatabaseCreationRefusal(scratch)).toBeNull()
  expect(existingDatabaseMigrationRefusal(scratch)).toBeNull()
})

test('the migrate and init-db creation decision refuses an absent BOTTEGA_ORCHESTRATOR_DB before touching its parent', () => {
  const parent = join(tmpdir(), `orch-explicit-${randomUUID()}`)
  const path = join(parent, 'orchestrator.db')
  const explicit = {
    path,
    method: 'BOTTEGA_ORCHESTRATOR_DB' as const,
    tried: [path],
    registeredPath: null,
    repositoryRoot: null,
    initializable: true,
    linkedWorktreeBinary: false,
    mainStorePath: path,
  }

  expect(implicitDatabaseCreationRefusal(explicit)).toBe(missingDatabaseMessage(path))
  expect(existsSync(path)).toBeFalse()
  expect(existsSync(parent)).toBeFalse()
})
