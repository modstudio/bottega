import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CONFIG_HOME_ENV, HARNESS_ENV_FILE_ENV } from '../../../shared/config-directory.ts'
import {
  ORCHESTRATOR_DATABASE_ENV,
  recordSessionStampPath,
  STATE_HOME_ENV,
} from '../../../shared/state-directory.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { recordLocalCommand } from './record-local-command.ts'
import { currentRecordWriteDecision } from './record-write-authority.ts'

function unconfiguredEnvironment(stateHome: string): Record<string, string | undefined> {
  return {
    HOME: stateHome,
    [CONFIG_HOME_ENV]: stateHome,
    [HARNESS_ENV_FILE_ENV]: '',
    [STATE_HOME_ENV]: stateHome,
    BOTTEGA_RECORD_API_URL: undefined,
  }
}

test('current write authority gathers binding and explicit-address facts', () => {
  const database = migratedTestDatabase()
  const environment = unconfiguredEnvironment('/tmp')
  expect(currentRecordWriteDecision(database, environment, '/tmp/store.db')).toEqual({
    verdict: 'local-authoritative',
  })
  database
    .query(
      "INSERT INTO record_install_binding(id,bound_at,record_origin) VALUES (1,'2026-11-05',NULL)",
    )
    .run()
  expect(currentRecordWriteDecision(database, environment, '/tmp/store.db')).toMatchObject({
    verdict: 'refused',
    boundOrigin: null,
  })
  database.close()
})

test('a session stamp refuses an unbound store until the verb marks that store local', () => {
  const stateHome = mkdtempSync(join(tmpdir(), 'record-write-authority-'))
  const database = migratedTestDatabase()
  const environment = unconfiguredEnvironment(stateHome)
  try {
    const stamp = recordSessionStampPath(environment)
    mkdirSync(dirname(stamp), { recursive: true })
    writeFileSync(stamp, 'joined')
    expect(currentRecordWriteDecision(database, environment, '/tmp/store.db')).toMatchObject({
      verdict: 'refused',
      boundOrigin: null,
    })
    recordLocalCommand(true, { log: () => undefined }, database)
    expect(currentRecordWriteDecision(database, environment, '/tmp/store.db')).toEqual({
      verdict: 'local-authoritative',
    })
  } finally {
    database.close()
    rmSync(stateHome, { recursive: true, force: true })
  }
})

test('a marked store does not pass its authority to a child environment using another store', () => {
  const stateHome = mkdtempSync(join(tmpdir(), 'record-write-inheritance-'))
  const marked = migratedTestDatabase()
  const child = migratedTestDatabase()
  try {
    const base = unconfiguredEnvironment(stateHome)
    const stamp = recordSessionStampPath(base)
    mkdirSync(dirname(stamp), { recursive: true })
    writeFileSync(stamp, 'joined')
    recordLocalCommand(true, { log: () => undefined }, marked)

    const childEnvironment = {
      ...process.env,
      ...base,
      [ORCHESTRATOR_DATABASE_ENV]: '/tmp/unmarked-child.db',
    }
    expect(
      currentRecordWriteDecision(
        child,
        childEnvironment,
        childEnvironment[ORCHESTRATOR_DATABASE_ENV],
      ),
    ).toMatchObject({ verdict: 'refused', boundOrigin: null })
  } finally {
    marked.close()
    child.close()
    rmSync(stateHome, { recursive: true, force: true })
  }
})

test('a non-row store path is local by design on a joined machine', () => {
  const stateHome = mkdtempSync(join(tmpdir(), 'record-write-null-store-'))
  const database = migratedTestDatabase()
  const environment = unconfiguredEnvironment(stateHome)
  try {
    const stamp = recordSessionStampPath(environment)
    mkdirSync(dirname(stamp), { recursive: true })
    writeFileSync(stamp, 'joined')
    expect(currentRecordWriteDecision(database, environment, '/dev/null')).toEqual({
      verdict: 'local-authoritative',
    })
    expect(currentRecordWriteDecision(database, environment, 'NUL')).toEqual({
      verdict: 'local-authoritative',
    })
  } finally {
    database.close()
    rmSync(stateHome, { recursive: true, force: true })
  }
})
