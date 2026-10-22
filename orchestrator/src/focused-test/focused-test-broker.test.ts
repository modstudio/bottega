import { expect, test } from 'bun:test'
import type { SandboxRuntimeConfig } from '../sandbox/sandbox.ts'
import { focusedTestBrokerLaunchDecision } from './focused-test-broker.ts'

test('a writing ACP focused-test launch is wrapped in its writer profile', () => {
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
  expect(
    focusedTestBrokerLaunchDecision({ kind: 'srt', profile }, 'bun', ['test', 'one.test.ts']),
  ).toEqual({
    kind: 'srt',
    profile,
    bin: 'bun',
    argv: ['test', 'one.test.ts'],
  })
})
