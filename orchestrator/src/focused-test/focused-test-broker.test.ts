import { expect, test } from 'bun:test'
import type { SandboxRuntimeConfig } from '../sandbox/sandbox.ts'
import {
  decideFocusedTestGroupExecution,
  focusedTestBrokerLaunchArgv,
} from './focused-test-broker.ts'

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

test('focused test groups aggregate results and stop before cancelled or refused work', () => {
  const first = { paths: ['one.test.ts'], started: true, exitCode: 0, timedOut: false }
  const second = { paths: ['two.test.ts'], started: true, exitCode: 2, timedOut: true }

  expect(
    decideFocusedTestGroupExecution({
      groupCount: 2,
      executions: [first, second],
      cancelled: false,
      refusedPaths: [],
    }),
  ).toEqual({
    nextGroupIndex: null,
    exitCode: 2,
    timedOut: true,
    started: true,
    stopped: 'complete',
  })
  expect(
    decideFocusedTestGroupExecution({
      groupCount: 2,
      executions: [first],
      cancelled: true,
      refusedPaths: [],
    }),
  ).toEqual({
    nextGroupIndex: null,
    exitCode: 0,
    timedOut: false,
    started: true,
    stopped: 'cancelled',
  })
  expect(
    decideFocusedTestGroupExecution({
      groupCount: 2,
      executions: [],
      cancelled: false,
      refusedPaths: ['unmatched.test.ts'],
    }),
  ).toEqual({
    nextGroupIndex: null,
    exitCode: 0,
    timedOut: false,
    started: false,
    stopped: 'refused',
  })
})
