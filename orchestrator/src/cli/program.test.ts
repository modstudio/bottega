import { expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CommanderError } from 'commander'
import { FROZEN_ENV_NAMES } from '../../../shared/brand.ts'
import type { PublicCommandInvocation } from '../../../shared/commander-public-path.ts'
import { readStoreLockRefusalsSince } from '../../../shared/store-lock-refusal-log.ts'
import { dir } from '../../test/fixtures/store.ts'
import {
  MIGRATION_DRAIN_REFUSAL_EXIT_CODE,
  MigrationDrainRefusalError,
} from '../database/database-commands.ts'
import { CLI_COMMANDS } from './args.ts'
import {
  isHelpShapedInvocation,
  isStoreFreeInvocation,
  runCliEntryForTest,
  storeFreeInvocationArgv,
} from './orch.ts'
import {
  exitCodeFor,
  invocationSkipsSessionStamp,
  lockedStoreMessage,
  program,
  run,
  usesReadOnlyStoreHandle,
} from './program.ts'

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
  expect(isStoreFreeInvocation(['setup', 'apply', '--yes'])).toBeTrue()
  expect(isStoreFreeInvocation(['setup', 'plan', '--json'])).toBeTrue()
  expect(isStoreFreeInvocation(['setup', 'restore', '/backup'])).toBeTrue()
  expect(isStoreFreeInvocation(['record', 'use', 'https://api.example.test'])).toBeTrue()
  expect(isStoreFreeInvocation(['setup'])).toBeTrue()
  expect(isStoreFreeInvocation(['release', 'check', 'v0.2.0'])).toBeTrue()
  expect(isStoreFreeInvocation(['load', 'sample'])).toBeTrue()
  expect(
    isStoreFreeInvocation(['machine', 'config', 'get', 'delegation.review', '--json']),
  ).toBeTrue()
  expect(isStoreFreeInvocation(['machine', 'config', 'list', '--machine', '--json'])).toBeTrue()
  expect(
    isStoreFreeInvocation(['gate', 'check', '--enabled'], {
      BOTTEGA_GATE_FACTS: '/tmp/facts.json',
    }),
  ).toBeTrue()
  expect(
    isStoreFreeInvocation(['check', '--enabled'], { BOTTEGA_GATE_FACTS: '/tmp/facts.json' }),
  ).toBeFalse()
  expect(
    storeFreeInvocationArgv(['check', '--enabled'], {
      ownerPath: ['check'],
      publicPath: ['gate', 'check'],
    }),
  ).toEqual(['gate', 'check', '--enabled'])
})

test('public routes preserve every store-free owner invocation at the executable entry', async () => {
  const routes = [
    { argv: ['monitor', '--help'], ownerPath: ['monitor'], publicPath: ['machine', 'monitor'] },
    {
      argv: ['record', 'use', 'https://api.example.test'],
      ownerPath: ['record'],
      publicPath: ['record'],
    },
    { argv: ['setup'], ownerPath: ['setup'], publicPath: ['machine', 'setup'] },
    { argv: ['setup', 'apply', '--yes'], ownerPath: ['setup'], publicPath: ['machine', 'setup'] },
    { argv: ['setup', 'plan', '--json'], ownerPath: ['setup'], publicPath: ['machine', 'setup'] },
    {
      argv: ['setup', 'restore', '/backup'],
      ownerPath: ['setup'],
      publicPath: ['machine', 'setup'],
    },
    { argv: ['setup', 'facts', '--json'], ownerPath: ['setup'], publicPath: ['machine', 'setup'] },
    {
      argv: ['test-substance', 'judge'],
      ownerPath: ['test-substance'],
      publicPath: ['gate', 'test-substance'],
    },
    {
      argv: ['hub-import', 'judge'],
      ownerPath: ['hub-import'],
      publicPath: ['gate', 'hub-import'],
    },
    {
      argv: ['release', 'check', 'v0.2.0'],
      ownerPath: ['release', 'check'],
      publicPath: ['release', 'check'],
    },
    { argv: ['check', '--enabled'], ownerPath: ['check'], publicPath: ['gate', 'check'] },
  ] satisfies Array<{ argv: string[] } & PublicCommandInvocation>
  const env = { [FROZEN_ENV_NAMES.gateFacts]: '/tmp/facts.json' }

  for (const { argv, ownerPath, publicPath } of routes) {
    let receivedStoreFree = false
    expect(
      await runCliEntryForTest(
        argv,
        async (_args, storeFree) => {
          receivedStoreFree = storeFree
          return 0
        },
        { ownerPath, publicPath },
        env,
      ),
    ).toBe(0)
    expect(receivedStoreFree, `${publicPath.join(' ')} must remain store-free`).toBeTrue()
  }
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
  expect(usesReadOnlyStoreHandle(['gate-facts', '--out', '/tmp/facts.json'])).toBeTrue()
  expect(usesReadOnlyStoreHandle(['wait', '1'])).toBeFalse()
  expect(usesReadOnlyStoreHandle(['run', 'wait', '1'])).toBeFalse()
  expect(usesReadOnlyStoreHandle(['monitor'])).toBeFalse()
})

test('a failed holder inspection cannot hide the original database lock refusal', async () => {
  const message = await lockedStoreMessage(
    { code: 'SQLITE_BUSY' },
    {
      inspect: async () => {
        throw new Error('shared-memory file is unreadable')
      },
    },
  )
  expect(message).toContain('database write refused: database is locked')
  expect(message).toContain(
    'holder: unknown (lock-holder inspection failed: shared-memory file is unreadable)',
  )
  expect(message).toContain('then retry the command')
})

test("a locked orchestrator store refusal names the sampled holder's pid and summarized command", async () => {
  const message = await lockedStoreMessage(
    { code: 'SQLITE_BUSY' },
    {
      argv: ['run', 'start', '--token', 'fixture'],
      inspect: async () => ({
        supported: true,
        classification: 'held',
        holderPid: 4242,
        sampleCount: 5,
        samples: [4242, 4242, 4242, 4242, 4242],
      }),
      commandOf: (pid) =>
        `/opt/bun /opt/orchestrator/src/cli/orch.ts run start --pid ${pid} --token fixture`,
    },
  )
  expect(message).toContain('store: ')
  expect(message).toContain('holder: pid 4242; command bun orch.ts')
  expect(message).toContain('then retry the command')
  expect(
    readStoreLockRefusalsSince('1970-01-01T00:00:00.000Z').filter(
      (entry) => entry.holderPid === 4242,
    ),
  ).toEqual([
    {
      at: expect.any(String),
      store: expect.any(String),
      holderCommand: 'bun orch.ts',
      holderPid: 4242,
      verb: 'run start',
    },
  ])
})

test('store-free setup invocations reach the executable entry without creating or mutating a store', async () => {
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
    for (const argv of [
      ['setup', 'facts', '--json'],
      ['setup', 'plan', '--json'],
      ['setup', 'apply', '--yes'],
    ]) {
      expect(await runCliEntryForTest(argv, enter)).toBe(0)
    }
    expect(existsSync(absent)).toBe(false)
    expect(readFileSync(existing, 'utf8')).toBe('unchanged fixture')
  } finally {
    rmSync(absent, { force: true })
    rmSync(existing, { force: true })
  }
})

test('the session stamp skips the ask-server invocation so its broker declaration is the first store open', () => {
  // A stamp opens the store read-only first, and a handle opened read-only can never be written
  // through afterwards — so the ask-server invocation must not be stamped.
  expect(invocationSkipsSessionStamp(['ask-server'])).toBeTrue()
  // Every other invocation still stamps as before.
  expect(invocationSkipsSessionStamp(['board', 'list'])).toBeFalse()
  expect(invocationSkipsSessionStamp(['ask', '--json'])).toBeFalse()
})
