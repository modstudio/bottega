import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PLATFORM_NAME, PLATFORM_SLUG } from './brand.ts'
import { registerEmbeddedAssets } from './embedded-assets.ts'
import {
  assetPath,
  checkoutHeadCommit,
  DIST_MANIFEST,
  type DistributionManifest,
  INSTALL_HOME_ENV,
  installationBuildId,
  installationVersionText,
  installRoot,
  isAuthorizedPlatformInstallation,
  isInstallationRoot,
  readDistributionManifest,
  resolveInstallationPaths,
  resolveInstallRoot,
} from './install-root.ts'

const scratchRoots: string[] = []

afterEach(() => {
  registerEmbeddedAssets(null)
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), `${PLATFORM_SLUG}-install-`))
  scratchRoots.push(root)
  return root
}

describe('install root resolution', () => {
  test('the env override wins when absolute', () => {
    expect(resolveInstallRoot('/from', { [INSTALL_HOME_ENV]: '/override/install' })).toBe(
      '/override/install',
    )
  })

  test('a relative env override is ignored', () => {
    const root = scratch()
    const nested = join(root, 'shared')
    mkdirSync(nested)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: PLATFORM_SLUG }))
    expect(resolveInstallRoot(nested, { [INSTALL_HOME_ENV]: 'relative/install' })).toBe(root)
  })

  test('a directory carrying the distribution manifest resolves as a root', () => {
    const root = scratch()
    const nested = join(root, 'lib', 'shared')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(root, `.${PLATFORM_SLUG}-dist.json`), '{}')
    expect(resolveInstallRoot(nested, {})).toBe(root)
  })

  test('a checkout resolves as a root', () => {
    const root = scratch()
    const nested = join(root, 'shared')
    mkdirSync(nested)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: PLATFORM_SLUG }))
    expect(resolveInstallRoot(nested, {})).toBe(root)
  })

  test('a directory is an installation root only as a checkout or distribution', () => {
    const checkout = scratch()
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: PLATFORM_SLUG }))
    expect(isInstallationRoot(checkout)).toBeTrue()

    const distribution = scratch()
    writeFileSync(join(distribution, DIST_MANIFEST), '{}')
    expect(isInstallationRoot(distribution)).toBeTrue()

    expect(isInstallationRoot(scratch())).toBeFalse()
  })

  test('service paths use the resolved checkout or distribution root', () => {
    const root = scratch()
    writeFileSync(join(root, DIST_MANIFEST), '{}')
    expect(resolveInstallationPaths(join(root, 'ops'), {})).toEqual({
      root,
      executable: join(root, 'bin', PLATFORM_SLUG),
      ops: join(root, 'ops'),
      hubAssets: join(root, 'hub'),
    })

    expect(
      resolveInstallationPaths('/ignored', { [INSTALL_HOME_ENV]: '/installed/current' }),
    ).toEqual({
      root: '/installed/current',
      executable: join('/installed/current', 'bin', PLATFORM_SLUG),
      ops: '/installed/current/ops',
      hubAssets: '/installed/current/hub',
    })
  })

  test('the refusal names the remedy', () => {
    const root = scratch()
    expect(() => resolveInstallRoot(root, {})).toThrow(
      `set ${INSTALL_HOME_ENV} to the absolute installation root`,
    )
  })
})

test('assetPath joins segments against the running install root', () => {
  expect(assetPath('bin', PLATFORM_SLUG)).toBe(join(installRoot(), 'bin', PLATFORM_SLUG))
})

describe('installation identity', () => {
  const manifest = {
    name: PLATFORM_NAME,
    version: '1.2.3',
    built: '2026-09-18T12:34:56.000Z',
    commit: 'abcdef1234567890',
  } satisfies DistributionManifest

  test('an installed root with a valid manifest is authorized', () => {
    const root = scratch()
    writeFileSync(join(root, DIST_MANIFEST), JSON.stringify(manifest))
    expect(isAuthorizedPlatformInstallation(root, {}, false)).toBeTrue()
    expect(readDistributionManifest(root)).toEqual(manifest)
  })

  test('a checkout remains authorized by its existing checkout condition', () => {
    const root = scratch()
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: PLATFORM_SLUG, version: '0.1.0' }),
    )
    expect(isAuthorizedPlatformInstallation(root, {}, true)).toBeTrue()
  })

  test('a directory that is neither installation kind is refused', () => {
    const root = scratch()
    expect(isAuthorizedPlatformInstallation(root, {}, false)).toBeFalse()
  })

  test('a present but unparseable manifest is refused as damaged', () => {
    const root = scratch()
    writeFileSync(join(root, DIST_MANIFEST), '{')
    expect(() => isAuthorizedPlatformInstallation(root, {}, false)).toThrow(
      `cannot establish an authorized ${PLATFORM_NAME} installation: distribution manifest ${join(root, DIST_MANIFEST)} is damaged:`,
    )
    expect(() => isAuthorizedPlatformInstallation(root, {}, false)).toThrow(
      `cleared by: reinstall ${PLATFORM_NAME} at ${root}`,
    )
  })

  test('--version text distinguishes a release from a development checkout', () => {
    const release = scratch()
    writeFileSync(join(release, DIST_MANIFEST), JSON.stringify(manifest))
    expect(installationVersionText(release, {})).toBe(`${PLATFORM_NAME} 1.2.3 (abcdef1)`)

    const checkout = scratch()
    writeFileSync(
      join(checkout, 'package.json'),
      JSON.stringify({ name: PLATFORM_SLUG, version: '0.1.0' }),
    )
    expect(installationVersionText(checkout, {})).toBe(
      `${PLATFORM_NAME} 0.1.0 (development checkout)`,
    )
  })

  test('a development checkout build is the main checkout commit, a distribution keeps its recorded commit', () => {
    const commit = '0123456789abcdef0123456789abcdef01234567'
    const checkout = scratch()
    writeFileSync(
      join(checkout, 'package.json'),
      JSON.stringify({ name: PLATFORM_SLUG, version: '0.1.0' }),
    )
    mkdirSync(join(checkout, '.git'))
    writeFileSync(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(join(checkout, '.git', 'refs', 'heads'), { recursive: true })
    writeFileSync(join(checkout, '.git', 'refs', 'heads', 'main'), `${commit}\n`)
    expect(installationBuildId(checkout, {})).toBe(commit)
    expect(checkoutHeadCommit(checkout)).toBe(commit)

    const unreadable = scratch()
    writeFileSync(
      join(unreadable, 'package.json'),
      JSON.stringify({ name: PLATFORM_SLUG, version: '0.1.0' }),
    )
    mkdirSync(join(unreadable, '.git'))
    writeFileSync(join(unreadable, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    expect(installationBuildId(unreadable, {})).toBeNull()
    expect(checkoutHeadCommit(unreadable)).toBeUndefined()

    const packed = scratch()
    writeFileSync(
      join(packed, 'package.json'),
      JSON.stringify({ name: PLATFORM_SLUG, version: '0.1.0' }),
    )
    mkdirSync(join(packed, '.git'))
    writeFileSync(join(packed, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(packed, '.git', 'packed-refs'), `# pack\n${commit} refs/heads/main\n`)
    expect(checkoutHeadCommit(packed)).toBe(commit)

    const worktree = scratch()
    const mainGit = join(checkout, '.git')
    const linked = join(mainGit, 'worktrees', 'run')
    mkdirSync(linked, { recursive: true })
    writeFileSync(
      join(worktree, 'package.json'),
      JSON.stringify({ name: PLATFORM_SLUG, version: '0.1.0' }),
    )
    writeFileSync(join(worktree, '.git'), `gitdir: ${linked}\n`)
    writeFileSync(join(linked, 'commondir'), '../..\n')
    writeFileSync(join(linked, 'HEAD'), 'ref: refs/heads/other\n')
    expect(checkoutHeadCommit(worktree)).toBe(commit)

    const release = scratch()
    writeFileSync(join(release, DIST_MANIFEST), JSON.stringify(manifest))
    expect(installationBuildId(release, {})).toBe(manifest.commit)
  })

  test('an embedded manifest renders the same identity without an installation on disk', () => {
    const release = scratch()
    writeFileSync(join(release, DIST_MANIFEST), JSON.stringify(manifest))
    const diskVersion = installationVersionText(release, {})

    registerEmbeddedAssets({ assets: {}, files: {}, manifest })
    expect(installationVersionText('/$bunfs/root', {})).toBe(diskVersion)
    expect(isAuthorizedPlatformInstallation('/$bunfs/root', {}, false)).toBeTrue()
    expect(installRoot()).toBe(dirname(process.execPath))
  })
})
