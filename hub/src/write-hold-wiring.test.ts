import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATE_HOME_ENV } from '../../shared/state-directory.ts'
import { readStoreWriteHoldsSince } from '../../shared/store-write-hold-log.ts'
import { closeDatabaseForFixture, writeTransaction } from './db.ts'

const originalStateHome = process.env[STATE_HOME_ENV]
let stateHome = ''

beforeEach(() => {
  stateHome = mkdtempSync(join(tmpdir(), 'store-write-holds-'))
  process.env[STATE_HOME_ENV] = stateHome
  closeDatabaseForFixture()
})

afterEach(() => {
  closeDatabaseForFixture()
  chmodSync(stateHome, 0o700)
  rmSync(stateHome, { recursive: true, force: true })
  if (originalStateHome === undefined) delete process.env[STATE_HOME_ENV]
  else process.env[STATE_HOME_ENV] = originalStateHome
})

test('a depth-zero write records a closed long-hold window without changing its error', () => {
  const readings = [100, 1_200, 2_000, 2_010]
  const realNow = performance.now.bind(performance)
  const now = spyOn(performance, 'now').mockImplementation(() =>
    new Error().stack?.includes('/hub/src/db.ts') ? (readings.shift() ?? 2_010) : realNow(),
  )
  try {
    expect(() =>
      writeTransaction(() => {
        throw new Error('transaction failed')
      }),
    ).toThrow('transaction failed')
    writeTransaction(() => undefined)

    const entries = readStoreWriteHoldsSince('1970-01-01T00:00:00.000Z')
    expect(entries.at(-1)).toMatchObject({
      store: 'hub.db',
      spanMs: 1_100,
      longestMs: 1_100,
      transactions: 1,
    })
    expect(entries.at(-1)?.caller).toMatch(/^hub\/src\/write-hold-wiring\.test\.ts:\d+$/)
  } finally {
    now.mockRestore()
  }
})
