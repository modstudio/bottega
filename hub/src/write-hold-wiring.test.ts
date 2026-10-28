import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATE_HOME_ENV } from '../../shared/state-directory.ts'
import { readStoreWriteHoldsSince } from '../../shared/store-write-hold-log.ts'
import {
  closeDatabaseForFixture,
  DB_PATH,
  db,
  writeCallerFromStack,
  writeTransaction,
} from './db.ts'

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
  const measuredPath = join(stateHome, 'measured.db')
  const measured = new Database(measuredPath, { create: true })
  const now = spyOn(performance, 'now').mockImplementation(() =>
    new Error().stack?.includes('/hub/src/db.ts') ? (readings.shift() ?? 2_010) : realNow(),
  )
  try {
    expect(() =>
      writeTransaction(() => {
        throw new Error('transaction failed')
      }, measured),
    ).toThrow('transaction failed')
    writeTransaction(() => undefined, measured)

    const entries = readStoreWriteHoldsSince('1970-01-01T00:00:00.000Z')
    expect(entries.at(-1)).toMatchObject({
      store: realpathSync(measuredPath),
      spanMs: 1_100,
      longestMs: 1_100,
      transactions: 1,
    })
    expect(entries.at(-1)?.caller).toMatch(/^hub\/src\/write-hold-wiring\.test\.ts:\d+$/)
  } finally {
    now.mockRestore()
    measured.close()
  }
})

test('a write that cannot acquire the lock is not recorded as a hold', () => {
  db().exec('PRAGMA busy_timeout = 1')
  const holder = new Database(DB_PATH, { readwrite: true, create: false })
  holder.exec('BEGIN IMMEDIATE')
  try {
    expect(() => writeTransaction(() => undefined)).toThrow('database is locked')
    expect(readStoreWriteHoldsSince('1970-01-01T00:00:00.000Z')).toEqual([])
  } finally {
    holder.exec('ROLLBACK')
    holder.close()
  }
})

test('caller frames are labeled from plain, URL, parenthesized, and embedded paths', () => {
  const source = '/repo/hub/src/db.ts'
  expect(writeCallerFromStack('Error\n    at run (/repo/hub/src/outbox.ts:452:3)', source)).toBe(
    'hub/src/outbox.ts:452',
  )
  expect(writeCallerFromStack('Error\n    at file:///repo/hub/src/tasks.ts:9:1', source)).toBe(
    'hub/src/tasks.ts:9',
  )
  expect(writeCallerFromStack('Error\n    at run (/repo/hub/src/a (copy):17:4)', source)).toBe(
    'hub/src/a (copy):17',
  )
  expect(
    writeCallerFromStack(
      'Error\n    at run (/$bunfs/root/hub/src/outbox.ts:31:2)',
      '/$bunfs/root/hub/src/db.ts',
    ),
  ).toBe('hub/src/outbox.ts:31')
})
