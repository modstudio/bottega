import { expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { useFixtureInstallationRoot } from '../../test/fixtures/installation-root.ts'
import { dir } from '../../test/fixtures/store.ts'
import { machineUpdateCommandUnderLock as machineUpdateCommand } from './machine-update.ts'
import { migrationJournal } from './migrations.ts'

useFixtureInstallationRoot()

function checkoutDependencies(events: string[]) {
  return {
    cwd: dir,
    authorityRefusal: () => null,
    project: () => ({
      name: 'migration-update-fixture',
      path: dir,
      settings: { trunk: 'main' },
    }),
    git: (_cwd: string, args: string[]) => {
      if (args[0] === 'branch') return 'main'
      if (args[0] === 'show') return JSON.stringify({ entries: migrationJournal() })
      return args[0] === 'rev-parse' ? 'current-before' : ''
    },
    migrate: () => events.push('migrate'),
    syncWorkflows: () => events.push('sync'),
    maintainStore: () => events.push('maintain'),
    runLaunchAgentsRefreshVerb: () => events.push('refresh'),
    verifyMainCheckout: () => events.push('verify'),
    releaseHostedRows: async () => {
      events.push('release')
      throw new Error('release refusal')
    },
  }
}

test('checkout update runs hosted-row release last and preserves its refusal', async () => {
  const events: string[] = []
  await expect(
    machineUpdateCommand({ log: () => {} }, checkoutDependencies(events)),
  ).rejects.toThrow('release refusal')
  expect(events).toEqual(['migrate', 'verify', 'sync', 'maintain', 'refresh', 'verify', 'release'])
})

test('distribution update runs hosted-row release after maintenance and refresh', async () => {
  const events: string[] = []
  await expect(
    machineUpdateCommand(
      { log: () => {} },
      {
        authorityRefusal: () => null,
        identity: {
          kind: 'distribution',
          root: resolve(realpathSync(process.execPath), '..'),
          manifest: {
            name: PLATFORM_NAME,
            version: '1.2.3',
            built: '2026-11-18T12:00:00.000Z',
            commit: 'abc1234',
          },
        },
        updateDistribution: async () => {
          events.push('update')
        },
        maintainStore: () => events.push('maintain'),
        runLaunchAgentsRefreshVerb: () => events.push('refresh'),
        releaseHostedRows: async () => {
          events.push('release')
          throw new Error('release refusal')
        },
      },
    ),
  ).rejects.toThrow('release refusal')
  expect(events).toEqual(['update', 'maintain', 'refresh', 'release'])
})
