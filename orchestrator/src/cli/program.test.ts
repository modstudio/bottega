import { expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CommanderError } from 'commander'
import { dir } from '../../test/fixtures/store.ts'
import {
  MIGRATION_DRAIN_REFUSAL_EXIT_CODE,
  MigrationDrainRefusalError,
} from '../database/database-commands.ts'
import { CLI_COMMANDS } from './args.ts'
import { isHelpShapedInvocation, isStoreFreeInvocation, runCliEntryForTest } from './orch.ts'
import { exitCodeFor, lockedStoreMessage, program, run, usesReadOnlyStoreHandle } from './program.ts'

test('the outer CLI classifies every informational invocation without consulting the store', () => {
  for (const argv of [
    [],
    ['help'],
    ['--help'],
    ['-h'],
    ['jobs', '--help'],
    ['jobs', '-h'],
    ['--version'],
  ]) {
    expect(isHelpShapedInvocation(argv)).toBeTrue()
  }
  expect(isHelpShapedInvocation(['jobs'])).toBeFalse()
  expect(isStoreFreeInvocation(['setup', 'facts', '--json'])).toBeTrue()
  expect(isStoreFreeInvocation(['record', 'use', 'https://api.example.test'])).toBeTrue()
  expect(isStoreFreeInvocation(['setup'])).toBeFalse()
  expect(isStoreFreeInvocation(['release', 'check', 'v0.2.0'])).toBeTrue()
})

test('canon command recognition is pinned to the Commander registry', () => {
  const registered = new Set([
    'init-db',
    ...program.commands.flatMap((command) => [command.name(), ...command.aliases()]),
  ])
  expect([...CLI_COMMANDS].sort()).toEqual([...registered].sort())
})

test('the retired top-level probe spelling is not registered', () => {
  expect(program.commands.some((command) => command.name() === 'probe')).toBeFalse()
})

test('an unknown command keeps exit 2 and migration drain refusals carry their declared code', async () => {
  expect(exitCodeFor(new CommanderError(1, 'commander.unknownCommand', 'unknown command'))).toBe(2)
  expect(await run(['definitely-not-a-command'])).toBe(2)
  expect(exitCodeFor(new MigrationDrainRefusalError('draining'))).toBe(
    MIGRATION_DRAIN_REFUSAL_EXIT_CODE,
  )
})

test('run query verbs use the read-only store handle', () => {
  expect(usesReadOnlyStoreHandle(['runs', '--json'])).toBeTrue()
  expect(usesReadOnlyStoreHandle(['run', '01990000-0000-7000-8000-000000000001'])).toBeTrue()
  expect(usesReadOnlyStoreHandle(['result', '1'])).toBeTrue()
  expect(usesReadOnlyStoreHandle(['run', '--receipt', '42'])).toBeTrue()
  expect(usesReadOnlyStoreHandle(['result', '--quiet', '1'])).toBeTrue()
  expect(usesReadOnlyStoreHandle(['wait', '1'])).toBeFalse()
  expect(usesReadOnlyStoreHandle(['run', 'wait', '1'])).toBeFalse()
  expect(usesReadOnlyStoreHandle(['monitor'])).toBeFalse()
})

test('a failed holder inspection cannot hide the original database lock refusal', async () => {
  const message = await lockedStoreMessage({ code: 'SQLITE_BUSY' }, async () => {
    throw new Error('shared-memory file is unreadable')
  })
  expect(message).toContain('database write refused: database is locked')
  expect(message).toContain(
    'holder: unknown (lock-holder inspection failed: shared-memory file is unreadable)',
  )
  expect(message).toContain('then retry the command')
})

test('setup facts reaches the executable entry without creating or mutating a store', async () => {
  const absent = join(dir, 'setup-facts-absent.db')
  const existing = join(dir, 'setup-facts-existing.db')
  writeFileSync(existing, 'unchanged fixture')
  const enter = async (_argv: string[], storeFree: boolean) => {
    if (!storeFree) {
      writeFileSync(absent, 'created')
      writeFileSync(existing, 'mutated')
    }
    return 0
  }

  try {
    expect(await runCliEntryForTest(['setup', 'facts', '--json'], enter)).toBe(0)
    expect(existsSync(absent)).toBe(false)
    expect(readFileSync(existing, 'utf8')).toBe('unchanged fixture')
  } finally {
    rmSync(absent, { force: true })
    rmSync(existing, { force: true })
  }
})
