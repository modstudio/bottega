import { describe, expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import {
  decideOrchestratorDatabasePath,
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

test('the unauthorised default-store refusal names the condition and remedy', () => {
  expect(unauthorizedDatabaseInitializationMessage('/state/orch.db')).toBe(
    `refusing to initialize the default store: cannot establish an authorised ${PLATFORM_NAME} installation: /state/orch.db\n` +
      'invariant: A default store is initialized only by a checkout or an installed distribution.\n' +
      `cleared by: run orch init-db from a checkout or reinstall ${PLATFORM_NAME}`,
  )
})
