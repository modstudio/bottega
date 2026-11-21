import { describe, expect, test } from 'bun:test'
import { sandboxToolchainPath } from './sandbox-toolchain-path.ts'

describe('sandboxToolchainPath', () => {
  test.each([
    [
      { platform: 'darwin', developerDir: '/Developer', path: '/usr/bin:/bin' },
      '/Developer/usr/bin:/usr/bin:/bin',
    ],
    [{ platform: 'darwin', developerDir: null, path: '/usr/bin:/bin' }, '/usr/bin:/bin'],
    [{ platform: 'linux', developerDir: '/Developer', path: '/usr/bin:/bin' }, '/usr/bin:/bin'],
    [
      { platform: 'darwin', developerDir: '/Developer', path: '/Developer/usr/bin:/usr/bin' },
      '/Developer/usr/bin:/usr/bin',
    ],
  ] as const)('maps %o to %s', (input, expected) => {
    expect(sandboxToolchainPath(input)).toBe(expected)
  })
})
