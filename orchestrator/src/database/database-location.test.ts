import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import {
  decideOrchestratorDatabasePath,
  existingDatabaseMigrationRefusal,
  implicitDatabaseCreationRefusal,
  linkedWorktreeDatabaseInitializationMessage,
  missingDatabaseMessage,
  unauthorizedDatabaseInitializationMessage,
} from './database-location.ts'

const livePath = '/nonexistent-live-orchestrator-store/orch.db'
const tempPath = '/nonexistent-temp-orchestrator-store/orch.db'

describe('orchestrator database path decision', () => {
  test('test process + non-ORCH_DB method: refuses the live fallback', () => {
    expect(() => decideOrchestratorDatabasePath(true, 'state-root', livePath)).toThrow(
      `test process refuses orchestrator database: ORCH_DB resolved <unset>; live store is ${livePath}\n` +
        'invariant: A test suite never falls back to the live orchestrator database.\n' +
        'cleared by: set ORCH_DB to a scratch store before importing orchestrator/src/database/db.ts',
    )
  })

  test("test process + 'ORCH_DB' method: returns the path", () => {
    expect(decideOrchestratorDatabasePath(true, 'ORCH_DB', tempPath)).toBe(tempPath)
  })

  test('non-test + fallback method: returns the path', () => {
    expect(decideOrchestratorDatabasePath(false, 'state-root', livePath)).toBe(livePath)
  })
})

test('the unauthorized default-store refusal names the condition and remedy', () => {
  expect(unauthorizedDatabaseInitializationMessage('/state/orch.db')).toBe(
    `refusing to initialize the default store: cannot establish an authorized ${PLATFORM_NAME} installation: /state/orch.db\n` +
      'invariant: A default store is initialized only by a checkout or an installed distribution.\n' +
      `cleared by: run the command from the main checkout or reinstall ${PLATFORM_NAME}`,
  )
})

test('the absent explicit-store refusal names the condition and explicit remedy', () => {
  expect(missingDatabaseMessage('/scratch/missing.db')).toBe(
    'orchestrator database does not exist: /scratch/missing.db\n' +
      'invariant: An absent ORCH_DB path is a mistake, not a request to create a store.\n' +
      'cleared by: unset ORCH_DB to use the installation store, or name an existing database',
  )
})

test('implicit creation uses the existing installation authority decision', () => {
  const authorized = {
    path: '/state/orch.db',
    method: 'state-root' as const,
    tried: ['/state/orch.db'],
    registeredPath: null,
    repositoryRoot: '/checkout',
    initializable: true,
    linkedWorktreeBinary: false,
    mainStorePath: '/state/orch.db',
  }
  expect(implicitDatabaseCreationRefusal(authorized)).toBeNull()
  expect(implicitDatabaseCreationRefusal({ ...authorized, linkedWorktreeBinary: true })).toBe(
    linkedWorktreeDatabaseInitializationMessage(),
  )
  expect(implicitDatabaseCreationRefusal({ ...authorized, initializable: false })).toBe(
    unauthorizedDatabaseInitializationMessage('/state/orch.db'),
  )
  expect(implicitDatabaseCreationRefusal({ ...authorized, method: 'ORCH_DB' })).toBe(
    missingDatabaseMessage('/state/orch.db'),
  )
})

test('migrating an existing store retains the linked-worktree refusal', () => {
  const existing = {
    path: '/state/orch.db',
    method: 'state-root' as const,
    tried: ['/state/orch.db'],
    registeredPath: null,
    repositoryRoot: '/checkout',
    initializable: true,
    linkedWorktreeBinary: true,
    mainStorePath: '/state/orch.db',
  }

  expect(existingDatabaseMigrationRefusal(existing)).toBe(
    linkedWorktreeDatabaseInitializationMessage(),
  )
  expect(existingDatabaseMigrationRefusal({ ...existing, linkedWorktreeBinary: false })).toBeNull()
})

test('the migrate and init-db creation decision refuses an absent ORCH_DB before touching its parent', () => {
  const parent = join(tmpdir(), `orch-explicit-${randomUUID()}`)
  const path = join(parent, 'orch.db')
  const explicit = {
    path,
    method: 'ORCH_DB' as const,
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
