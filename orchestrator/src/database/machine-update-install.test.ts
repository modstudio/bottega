import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { INSTALL_HOME_ENV } from '../../../shared/install-root.ts'
import { dir } from '../../test/fixtures/store.ts'
import {
  machineUpdateCommandUnderLock as machineUpdateCommand,
  pulledRangeChangesPackageJson,
  unregisteredMainCheckoutRefusal,
} from './machine-update.ts'
import { migrationJournal } from './migrations.ts'

const fixturePackage = join(dir, 'package.json')
beforeAll(() => writeFileSync(fixturePackage, JSON.stringify({ name: PLATFORM_SLUG })))
afterAll(() => rmSync(fixturePackage, { force: true }))

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
  { changedPaths: 'package.json\0', expected: ['pull', 'install', 'migrate'] },
  { changedPaths: 'shared/source.ts\0', expected: ['pull', 'migrate'] },
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
        runLaunchAgentsRefreshVerb: () => {},
      },
    )
    expect(events).toEqual(expected)
  },
)
