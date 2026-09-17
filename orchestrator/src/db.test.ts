import { describe, expect, test } from 'bun:test'
import {
  closeDatabaseForFixture,
  db,
  decideOrchestratorDatabasePath,
  registerOpenHooks,
} from './db.ts'

const livePath = '/nonexistent-live-orchestrator-store/orch.db'
const tempPath = '/nonexistent-temp-orchestrator-store/orch.db'

describe('orchestrator database path decision', () => {
  test('test-process unset ORCH_DB mutation: refuses the live fallback', () => {
    expect(() => decideOrchestratorDatabasePath(true, undefined, livePath)).toThrow(
      `test process refuses orchestrator database: ORCH_DB resolved <unset>; live store is ${livePath}\n` +
        'invariant: A test suite never falls back to the live orchestrator database.\n' +
        'cleared by: set ORCH_DB to a scratch store before importing orchestrator/src/db.ts',
    )
  })

  test('test-process temp ORCH_DB mutation: uses the scratch store', () => {
    expect(decideOrchestratorDatabasePath(true, tempPath, tempPath)).toBe(tempPath)
  })

  test('non-test unset ORCH_DB mutation: uses the resolved store', () => {
    expect(decideOrchestratorDatabasePath(false, undefined, livePath)).toBe(livePath)
  })
})

test('a writable open refuses when no hooks are registered', () => {
  closeDatabaseForFixture()
  const restore = registerOpenHooks({})
  try {
    expect(() => db()).toThrow(
      process.env.ORCH_DB
        ? /registerStandardHooks\(\)/
        : /test process refuses orchestrator database/,
    )
  } finally {
    restore()
  }
})
