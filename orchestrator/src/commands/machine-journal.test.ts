import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { migrationJournal } from '../database/migrations.ts'
import { MACHINE_JOURNAL_SCHEMA } from '../machine-journal.ts'
import { machineJournalCommand } from './machine-journal.ts'

const priorStateHome = process.env.BOTTEGA_STATE_HOME
let stateHome = ''

beforeEach(() => {
  stateHome = mkdtempSync(join(tmpdir(), 'machine-journal-state-'))
  process.env.BOTTEGA_STATE_HOME = stateHome
})

afterEach(() => {
  if (priorStateHome === undefined) delete process.env.BOTTEGA_STATE_HOME
  else process.env.BOTTEGA_STATE_HOME = priorStateHome
  rmSync(stateHome, { recursive: true, force: true })
})

test('prints the validated embedded journal without touching the state home', () => {
  const stdout: string[] = []

  machineJournalCommand(true, { write: (value) => stdout.push(value) })

  expect(stdout).toHaveLength(1)
  expect(stdout[0]!.endsWith('\n')).toBeTrue()
  const parsed = MACHINE_JOURNAL_SCHEMA.parse(JSON.parse(stdout[0]!))
  expect(parsed.orchestratorJournal).toHaveLength(migrationJournal().length)
  expect(parsed.orchestratorJournal.length).toBeGreaterThan(0)
  expect(readdirSync(stateHome)).toEqual([])
})

test('refuses output without --json', () => {
  expect(() => machineJournalCommand(false, { write: () => {} })).toThrow(
    `machine journal prints JSON only\ncleared by: ${PLATFORM_SLUG} machine journal --json`,
  )
})
