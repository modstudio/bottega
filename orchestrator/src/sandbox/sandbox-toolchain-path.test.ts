import { describe, expect, test } from 'bun:test'
import { sandboxToolchainPrefix } from './sandbox-toolchain-path.ts'

describe('sandboxToolchainPrefix', () => {
  test.each([
    ['darwin', '/Developer', 'PATH=/Developer/usr/bin${PATH:+:$PATH}; export PATH; '],
    ['darwin', null, ''],
    ['linux', '/Developer', ''],
    [
      'darwin',
      "/Developer's Tools",
      `PATH='/Developer'"'"'s Tools/usr/bin'\${PATH:+:$PATH}; export PATH; `,
    ],
    [
      'darwin',
      '/Developer Tools',
      `PATH='/Developer Tools/usr/bin'\${PATH:+:$PATH}; export PATH; `,
    ],
  ] as const)('maps %s and %s to %s', (platform, developerDir, expected) => {
    expect(sandboxToolchainPrefix(platform, developerDir)).toBe(expected)
  })
})
