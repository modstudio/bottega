import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetFixtureStore } from './run-fixtures.ts'

let directory: string
let unmintedDatabase: string
let previousHubDatabase: string | undefined
let previousNodeEnvironment: string | undefined

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hub-fixture-reset-refusal-'))
  unmintedDatabase = join(realpathSync(directory), 'hub.db')
  previousHubDatabase = process.env.BOTTEGA_HUB_DB
  previousNodeEnvironment = process.env.NODE_ENV
  process.env.BOTTEGA_HUB_DB = unmintedDatabase
  delete process.env.NODE_ENV
})

afterEach(() => {
  if (previousHubDatabase === undefined) delete process.env.BOTTEGA_HUB_DB
  else process.env.BOTTEGA_HUB_DB = previousHubDatabase
  if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = previousNodeEnvironment
  rmSync(directory, { recursive: true, force: true })
})

test('resetFixtureStore refuses an unminted store before opening it', () => {
  expect(() => resetFixtureStore()).toThrow(
    `test process refuses hub database: BOTTEGA_HUB_DB resolved ${unmintedDatabase}`,
  )
  expect(existsSync(unmintedDatabase)).toBeFalse()
})
