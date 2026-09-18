import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_NAME, PLATFORM_SLUG } from './brand.ts'
import {
  assetPath,
  DIST_MANIFEST,
  INSTALL_HOME_ENV,
  installationVersionText,
  installRoot,
  isAuthorizedPlatformInstallation,
  readDistributionManifest,
  resolveInstallationPaths,
  resolveInstallRoot,
} from './install-root.ts'

const scratchRoots: string[] = []

afterEach(() => {
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

  test('service paths use the resolved checkout or distribution root', () => {
    const root = scratch()
    writeFileSync(join(root, DIST_MANIFEST), '{}')
    expect(resolveInstallationPaths(join(root, 'ops'), {})).toEqual({
      root,
      orch: join(root, 'bin', 'orch'),
      hub: join(root, 'bin', 'hub'),
      ops: join(root, 'ops'),
      hubAssets: join(root, 'hub'),
    })

    expect(
      resolveInstallationPaths('/ignored', { [INSTALL_HOME_ENV]: '/installed/current' }),
    ).toEqual({
      root: '/installed/current',
      orch: '/installed/current/bin/orch',
      hub: '/installed/current/bin/hub',
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
  expect(assetPath('bin', 'orch')).toBe(join(installRoot(), 'bin', 'orch'))
})

describe('installation identity', () => {
  const manifest = {
    name: PLATFORM_NAME,
    version: '1.2.3',
    built: '2026-09-18T12:34:56.000Z',
    commit: 'abcdef1234567890',
  }

  test('an installed root with a valid manifest is authorised', () => {
    const root = scratch()
    writeFileSync(join(root, DIST_MANIFEST), JSON.stringify(manifest))
    expect(isAuthorizedPlatformInstallation(root, {}, false)).toBeTrue()
    expect(readDistributionManifest(root)).toEqual(manifest)
  })

  test('a checkout remains authorised by its existing checkout condition', () => {
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
      `cannot establish an authorised ${PLATFORM_NAME} installation: distribution manifest ${join(root, DIST_MANIFEST)} is damaged:`,
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
})
