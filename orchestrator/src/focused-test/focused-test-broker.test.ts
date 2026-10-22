import { expect, test } from 'bun:test'
import type { SandboxRuntimeConfig } from '../sandbox/sandbox.ts'
import { focusedTestBrokerLaunchArgv } from './focused-test-broker.ts'

test('a writing ACP focused-test launch is wrapped in its writer profile', async () => {
  const profile: SandboxRuntimeConfig = {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowUnixSockets: [],
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: [],
      allowWithinDeny: [],
      allowWrite: ['/tree', '/scratch'],
      denyWrite: ['/tree/.git'],
    },
  }
  const seen: Array<{ profile: SandboxRuntimeConfig; bin: string; argv: string[] }> = []
  const launch = await focusedTestBrokerLaunchArgv(
    profile,
    'bun',
    ['test', 'one.test.ts'],
    async (selected, bin, argv) => {
      seen.push({ profile: selected, bin, argv })
      return ['srt', '--', bin, ...argv]
    },
  )

  expect(seen).toEqual([{ profile, bin: 'bun', argv: ['test', 'one.test.ts'] }])
  expect(launch).toEqual(['srt', '--', 'bun', 'test', 'one.test.ts'])
})
