import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { INSTALL_HOME_ENV } from '../../../shared/install-root.ts'
import { useFixtureInstallationRoot } from '../../test/fixtures/installation-root.ts'
import { dir } from '../../test/fixtures/store.ts'
import {
  machineUpdateCommandUnderLock as machineUpdateCommand,
  pulledRangeChangesPackageJson,
  unregisteredMainCheckoutRefusal,
} from './machine-update.ts'
import { migrationJournal } from './migrations.ts'

useFixtureInstallationRoot()

test('unregistered main checkout refusal names the registered binary when the register has one', () => {
  const same = (left: string, right: string) => left === right
  expect(unregisteredMainCheckoutRefusal('/install', null, same)).toBe(
    `refusing machine update: this installation's root /install is not a registered main checkout; run the registered main checkout's bin/${PLATFORM_SLUG} machine update, or unset ${INSTALL_HOME_ENV} if it points elsewhere`,
  )
  expect(unregisteredMainCheckoutRefusal('/install', { path: '/registered-main' }, same)).toBe(
    `refusing machine update: this installation's root /install is not a registered main checkout; run /registered-main/bin/${PLATFORM_SLUG} machine update, or unset ${INSTALL_HOME_ENV} if it points elsewhere`,
  )
  expect(unregisteredMainCheckoutRefusal('/install', { path: '/install' }, same)).toBeNull()
})

test.each([
  { paths: ['package.json'], changed: true },
  { paths: ['packages/worker/package.json'], changed: true },
  { paths: ['package.json.md', 'packages/worker.ts'], changed: false },
])('package.json path decision returns $changed for $paths', ({ paths, changed }) => {
  expect(pulledRangeChangesPackageJson(paths)).toBe(changed)
})

test.each([
  { changedPaths: 'package.json\0', expected: ['pull', 'install', 'migrate', 'workflow-sync'] },
  { changedPaths: 'shared/source.ts\0', expected: ['pull', 'migrate', 'workflow-sync'] },
])(
  'machine update orders dependency refresh for pulled paths $changedPaths',
  async ({ changedPaths, expected }) => {
    const events: string[] = []
    await machineUpdateCommand(
      { log: () => {} },
      {
        cwd: dir,
        authorityRefusal: () => null,
        project: () => ({
          name: 'migration-update-fixture',
          path: dir,
          settings: { trunk: 'main' },
        }),
        git: (_cwd, args) => {
          if (args[0] === 'branch') return 'main'
          if (args[0] === 'show') return JSON.stringify({ entries: migrationJournal() })
          if (args[0] === 'rev-parse') return 'before-commit'
          if (args.includes('pull')) events.push('pull')
          if (args[0] === 'diff') return changedPaths
          return ''
        },
        install: () => events.push('install'),
        migrate: () => events.push('migrate'),
        syncWorkflows: (cwd, since) => {
          expect({ cwd, since }).toEqual({ cwd: dir, since: 'before-commit' })
          events.push('workflow-sync')
        },
        runLaunchAgentsRefreshVerb: () => {},
      },
    )
    expect(events).toEqual([...expected])
  },
)

test('machine update verifies the main checkout before synchronizing workflows', async () => {
  let synchronized = false
  await expect(
    machineUpdateCommand(
      { log: () => {} },
      {
        cwd: dir,
        authorityRefusal: () => null,
        project: () => ({
          name: 'migration-update-fixture',
          path: dir,
          settings: { trunk: 'main' },
        }),
        git: (_cwd, args) => {
          if (args[0] === 'branch') return 'main'
          if (args[0] === 'show') return JSON.stringify({ entries: migrationJournal() })
          return args[0] === 'rev-parse' ? 'before-commit' : ''
        },
        migrate: () => {},
        verifyMainCheckout: () => {
          throw new Error('tracked workflow edit remains')
        },
        syncWorkflows: () => {
          synchronized = true
        },
      },
    ),
  ).rejects.toThrow('tracked workflow edit remains')
  expect(synchronized).toBeFalse()
})

test('machine update restores main when dependency install fails after the pull', async () => {
  const gitCalls: string[][] = []
  let migrated = false
  await expect(
    machineUpdateCommand(
      { log: () => {} },
      {
        cwd: dir,
        authorityRefusal: () => null,
        project: () => ({
          name: 'migration-update-fixture',
          path: dir,
          settings: { trunk: 'main' },
        }),
        git: (_cwd, args) => {
          gitCalls.push(args)
          if (args[0] === 'branch') return 'main'
          if (args[0] === 'show') return JSON.stringify({ entries: migrationJournal() })
          if (args[0] === 'rev-parse') return 'before-commit'
          if (args[0] === 'diff') return 'package.json\0'
          return ''
        },
        install: () => {
          throw new Error('injected install failure')
        },
        migrate: () => {
          migrated = true
        },
      },
    ),
  ).rejects.toThrow(
    `dependency install failed: injected install failure; main was restored to before-commit; rerun ${PLATFORM_SLUG} machine update`,
  )
  expect(migrated).toBeFalse()
  expect(gitCalls).toContainEqual(['reset', '--keep', 'before-commit'])
})

test('machine update restores main when pulled-path measurement fails after the pull', async () => {
  const gitCalls: string[][] = []
  await expect(
    machineUpdateCommand(
      { log: () => {} },
      {
        cwd: dir,
        authorityRefusal: () => null,
        project: () => ({
          name: 'migration-update-fixture',
          path: dir,
          settings: { trunk: 'main' },
        }),
        git: (_cwd, args) => {
          gitCalls.push(args)
          if (args[0] === 'branch') return 'main'
          if (args[0] === 'show') return JSON.stringify({ entries: migrationJournal() })
          if (args[0] === 'rev-parse') return 'before-commit'
          if (args[0] === 'diff') throw new Error('injected diff failure')
          return ''
        },
      },
    ),
  ).rejects.toThrow(
    `pulled-path measurement failed: injected diff failure; main was restored to before-commit; rerun ${PLATFORM_SLUG} machine update`,
  )
  expect(gitCalls).toContainEqual(['reset', '--keep', 'before-commit'])
})
