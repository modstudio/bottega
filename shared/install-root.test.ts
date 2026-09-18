import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from './brand.ts'
import { assetPath, INSTALL_HOME_ENV, installRoot, resolveInstallRoot } from './install-root.ts'

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
