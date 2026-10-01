import { afterEach, expect, test } from 'bun:test'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  assertInstallTargetSafe,
  decideProvision,
  decideProvisionGroup,
  installEnvironment,
  provisionWorktree,
  validateReadonlyProvision,
} from './worktree-provision.ts'

const roots: string[] = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-readonly-provision-'))
  roots.push(root)
  const main = join(root, 'main')
  const tree = join(root, 'tree')
  mkdirSync(main)
  mkdirSync(tree)
  return { main, tree }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('directory link entries use relative targets and survive moving the common root', () => {
  const { main, tree } = fixture()
  mkdirSync(join(main, 'node_modules'))
  writeFileSync(join(main, 'node_modules', '.hidden'), 'hidden')
  writeFileSync(join(main, 'node_modules', 'package'), 'contents')

  provisionWorktree(main, tree, [{ path: 'node_modules', method: 'link' }])

  expect(lstatSync(join(tree, 'node_modules')).isDirectory()).toBe(true)
  expect(lstatSync(join(tree, 'node_modules', 'package')).isSymbolicLink()).toBe(true)
  expect(lstatSync(join(tree, 'node_modules', '.hidden')).isSymbolicLink()).toBe(true)
  expect(readlinkSync(join(tree, 'node_modules', 'package'))).toBe(
    '../../main/node_modules/package',
  )
  expect(readFileSync(join(tree, 'node_modules', 'package'), 'utf8')).toBe('contents')

  const moved = `${dirname(main)}-moved`
  renameSync(dirname(main), moved)
  roots.splice(roots.indexOf(dirname(main)), 1, moved)
  expect(readFileSync(join(moved, 'tree', 'node_modules', 'package'), 'utf8')).toBe('contents')
})

test('file link is one relative symlink and survives moving the common root', () => {
  const { main, tree } = fixture()
  writeFileSync(join(main, '.env.testing.local'), 'TOKEN=value')

  provisionWorktree(main, tree, [{ path: '.env.testing.local', method: 'link' }])

  const target = join(tree, '.env.testing.local')
  expect(lstatSync(target).isSymbolicLink()).toBe(true)
  expect(readlinkSync(target)).toBe('../main/.env.testing.local')
  expect(readFileSync(target, 'utf8')).toBe('TOKEN=value')

  const moved = `${dirname(main)}-moved`
  renameSync(dirname(main), moved)
  roots.splice(roots.indexOf(dirname(main)), 1, moved)
  expect(readFileSync(join(moved, 'tree', '.env.testing.local'), 'utf8')).toBe('TOKEN=value')
})

test('missing source path is skipped and reported', () => {
  const { main, tree } = fixture()
  expect(provisionWorktree(main, tree, [{ path: 'missing', method: 'link' }])).toEqual([
    { path: 'missing', reason: 'missing source' },
  ])
  expect(() => lstatSync(join(tree, 'missing'))).toThrow()
})

test('provision decision fails only a missing required source', () => {
  expect(decideProvision({ path: 'vendor', method: 'clone' }, true)).toBe('provision')
  expect(decideProvision({ path: 'vendor', method: 'clone' }, false)).toBe('skip')
  expect(decideProvision({ path: 'vendor', method: 'clone', required: false }, false)).toBe('skip')
  expect(decideProvision({ path: 'vendor', method: 'clone', required: true }, false)).toBe('fail')
})

test('lockfile group decision provisions equal content and installs changed or absent source content', () => {
  const entries = [
    {
      path: 'node_modules',
      method: 'link' as const,
      lockfile: 'bun.lock',
      install: 'bun install --frozen-lockfile',
    },
  ]

  expect(decideProvisionGroup(entries, 'same', 'same')).toEqual({
    action: 'provision',
    entries,
  })
  expect(decideProvisionGroup(entries, 'branch', 'main')).toEqual({
    action: 'install',
    entries: [{ ...entries[0]!, method: 'clone' }],
  })
  expect(decideProvisionGroup(entries, 'branch', null)).toEqual({
    action: 'install',
    entries: [{ ...entries[0]!, method: 'clone' }],
  })
  expect(
    decideProvisionGroup(entries, 'branch', 'main').entries.some(
      (entry) => entry.method === 'link',
    ),
  ).toBeFalse()
})

test('install environment keeps only ordinary process context', () => {
  expect(
    installEnvironment({
      PATH: '/bin',
      HOME: '/home/reader',
      TMPDIR: '/tmp/reader',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      ORCH_DB: '/state/orch.db',
      ORCH_RUN_TOKEN: 'run-token',
      HUB_HOSTED_URL: 'https://hub.example',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      API_TOKEN: 'api-token',
      CLIENT_SECRET: 'client-secret',
      DB_PASSWORD: 'password',
      SIGNING_KEY: 'key',
      CLOUD_CREDENTIAL: 'credential',
      USER: 'reader',
    }),
  ).toEqual({
    PATH: '/bin',
    HOME: '/home/reader',
    TMPDIR: '/tmp/reader',
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    USER: 'reader',
  })
  expect(
    installEnvironment({
      PATH: '/bin',
      HOME: undefined,
      orch_db: '/state/orch.db',
      accessToken: 'token',
    }),
  ).toEqual({ PATH: '/bin' })
})

test('install target safety refuses a checked-in symlink even when it points inside the tree', () => {
  const { tree } = fixture()
  mkdirSync(join(tree, 'checked-in'))
  symlinkSync('checked-in', join(tree, 'node_modules'))

  expect(() =>
    assertInstallTargetSafe(tree, {
      path: 'node_modules',
      method: 'clone',
      lockfile: 'bun.lock',
      install: 'bun install --frozen-lockfile',
    }),
  ).toThrow('install-mode provision "node_modules" target is a symlink')
})

test('install target safety refuses a target whose real path leaves the tree', () => {
  const { tree } = fixture()
  const outside = join(tree, '..', 'outside-install-target')
  mkdirSync(join(outside, 'node_modules'), { recursive: true })
  symlinkSync(outside, join(tree, 'packages'))

  expect(() =>
    assertInstallTargetSafe(tree, {
      path: 'packages/node_modules',
      method: 'clone',
      lockfile: 'bun.lock',
      install: 'bun install --frozen-lockfile',
    }),
  ).toThrow('install-mode provision "packages/node_modules" target resolves outside the tree')
})

test('missing required source names the entry, source, and remedy', () => {
  const { main, tree } = fixture()
  expect(() =>
    provisionWorktree(
      main,
      tree,
      [{ path: 'vendor', method: 'clone', required: true }],
      `tracked recipe "${PLATFORM_SLUG}.jsonc"`,
    ),
  ).toThrow(
    `required provision "vendor" from tracked recipe "${PLATFORM_SLUG}.jsonc" is missing its source at ${join(main, 'vendor')}; install dependencies in the main checkout, or correct tracked recipe "${PLATFORM_SLUG}.jsonc"`,
  )
})

test('existing target is left alone', () => {
  const { main, tree } = fixture()
  mkdirSync(join(main, 'vendor'))
  mkdirSync(join(tree, 'vendor'))
  writeFileSync(join(main, 'vendor', 'source'), 'source')
  writeFileSync(join(tree, 'vendor', 'kept'), 'kept')

  provisionWorktree(main, tree, [{ path: 'vendor', method: 'clone' }])

  expect(readFileSync(join(tree, 'vendor', 'kept'), 'utf8')).toBe('kept')
  expect(() => lstatSync(join(tree, 'vendor', 'source'))).toThrow()
})

test('validation refuses malformed readonly provision declarations', () => {
  expect(validateReadonlyProvision([{ path: 'vendor', method: 'copy' }])).toEqual([
    "worktree.readonly_provision method must be 'link' or 'clone'",
  ])
  expect(validateReadonlyProvision([{ path: '/vendor', method: 'clone' }])).toEqual([
    'worktree.readonly_provision path must be a non-empty relative path without ..',
  ])
  expect(validateReadonlyProvision([{ path: '../vendor', method: 'link' }])).toEqual([
    'worktree.readonly_provision path must be a non-empty relative path without ..',
  ])
  expect(validateReadonlyProvision({ path: 'vendor', method: 'clone' })).toEqual([
    'worktree.readonly_provision must be an array',
  ])
  expect(
    validateReadonlyProvision([
      { path: 'vendor', method: 'clone' },
      { path: 'vendor', method: 'link' },
    ]),
  ).toEqual(['worktree.readonly_provision path must be unique: "vendor"'])
  expect(validateReadonlyProvision([{ path: 'vendor', method: 'clone', required: true }])).toEqual(
    [],
  )
  expect(validateReadonlyProvision([{ path: 'vendor', method: 'clone', required: 'yes' }])).toEqual(
    ['worktree.readonly_provision required must be a boolean'],
  )
})

test('validation requires each lockfile group to agree on its install command', () => {
  expect(
    validateReadonlyProvision([
      {
        path: 'node_modules',
        method: 'link',
        lockfile: 'bun.lock',
        install: 'bun install --frozen-lockfile',
      },
      {
        path: 'packages/app/node_modules',
        method: 'clone',
        lockfile: 'bun.lock',
        install: 'bun install',
      },
    ]),
  ).toEqual(['worktree.readonly_provision entries for lockfile "bun.lock" must agree on install'])
  expect(
    validateReadonlyProvision([
      {
        path: 'node_modules',
        method: 'link',
        lockfile: 'bun.lock',
        install: 'bun install --frozen-lockfile',
      },
      {
        path: 'vendor',
        method: 'clone',
        lockfile: 'composer.lock',
        install: 'composer install',
      },
    ]),
  ).toEqual([])
})

test('a path through a symlinked ancestor that leaves the tree is refused and creates nothing outside', () => {
  const { main, tree } = fixture()
  mkdirSync(join(main, 'deps', 'vendor'), { recursive: true })
  writeFileSync(join(main, 'deps', 'vendor', 'autoload.php'), '<?php')
  const outside = join(tree, '..', 'outside')
  mkdirSync(outside)
  symlinkSync(outside, join(tree, 'deps'))

  expect(() => provisionWorktree(main, tree, [{ path: 'deps/vendor', method: 'link' }])).toThrow(
    'resolves outside the tree',
  )
  expect(() => lstatSync(join(outside, 'vendor'))).toThrow()
})
