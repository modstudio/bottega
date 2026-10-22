import { expect, test } from 'bun:test'
import { decideBrokerLaunch } from '../gate/gate-decision.ts'
import { type SandboxRuntimeConfig, writerBrokerProfile } from '../sandbox/sandbox.ts'

test('a writing ACP focused-test launch retains its writer profile', () => {
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
  const profile = writerBrokerProfile(writer)
  expect(decideBrokerLaunch({ kind: 'srt', profile }, 'bun', ['test', 'one.test.ts'])).toEqual({
    kind: 'srt',
    profile,
    bin: 'bun',
    argv: ['test', 'one.test.ts'],
  })
})
