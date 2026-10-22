import { expect, test } from 'bun:test'
import type { SandboxRuntimeConfig } from '../sandbox/sandbox.ts'
import { focusedTestBrokerLaunchArgv } from './focused-test-broker.ts'

test('a writing ACP focused-test broker launches with the run writer profile unchanged', async () => {
  const writer: SandboxRuntimeConfig = {
    network: {
      allowedDomains: ['127.0.0.1:43127'],
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
  const profiles: SandboxRuntimeConfig[] = []
  expect(
    await focusedTestBrokerLaunchArgv(
      { kind: 'srt', profile: writer },
      'bun',
      ['test', 'one.test.ts'],
      async (profile, bin, argv) => {
        profiles.push(profile)
        return ['srt', bin, ...argv]
      },
    ),
  ).toEqual(['srt', 'bun', 'test', 'one.test.ts'])
  expect(profiles).toEqual([writer])
  expect(profiles[0]!.network).toBe(writer.network)
})
